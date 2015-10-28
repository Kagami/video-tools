extern crate libc;
extern crate freetype;
extern crate rustc_serialize;
extern crate docopt;

use std::io;
use std::io::Read;
use std::io::Write;
use std::fs::File;
use std::process;
use std::ptr;
use std::slice;
use libc::{c_int, c_double, c_void, c_char};
use docopt::Docopt;
use freetype as ft;

const BYTE_DEPTH: usize = 1;
const MAX_SIZE: usize = std::u16::MAX as usize;
const DEFAULT_FONT: &'static [u8] = include_bytes!("../8x13B.pcf.gz");

const USAGE: &'static str = "
Usage:
  y2aa [options] -w <width> -h <height> <path>
  y2aa --help

Make ASCII-art version of provided image data.
Reads Gray8 data from specified path (use - for stdin) frame by frame using
given video dimensions and outputs processed video in same format to stdout.
Meant to be used with some video format encoder/decoder, e.g. FFmpeg.

Options:
  --help                Show this message and exit.
  -w, --width=<w>       Video width, required.
  -h, --height=<h>      Video height, required.
  -f, --font=<f>        Path to the monospaced font, 8x13bold is default.
                        Both Truetype and PCF are supported.
  -s, --font-size=<fs>  Font size, required for Truetype fonts.

Example:
  ffmpeg -i in.mkv -f rawvideo -pix_fmt gray - |\\
    y2aa -w 1280 -h 720 - |\\
    ffmpeg -f rawvideo -pixel_format gray -video_size 1280x720 -i - out.mkv
";

macro_rules! printerr {
    ($fmt:expr) =>
        (::std::io::Write
            ::write_fmt(&mut ::std::io::stderr(), format_args!(concat!($fmt, "\n")))
            .unwrap());
    ($fmt:expr, $($arg:tt)*) =>
        (::std::io::Write
            ::write_fmt(&mut ::std::io::stderr(), format_args!(concat!($fmt, "\n"), $($arg)*))
            .unwrap());
}

macro_rules! get {
    ($e:expr) => (match $e { Ok(v) => v, Err(_) => return None });
}

#[derive(Debug, RustcDecodable)]
struct Args {
    flag_width: usize,
    flag_height: usize,
    arg_path: String,
    flag_font: Option<String>,
    flag_font_size: Option<usize>,
}

#[repr(C)]
struct aa_context;

#[repr(C)]
struct aa_driver;

#[repr(C)]
struct aa_font;

#[repr(C)]
#[derive(Clone)]
#[allow(raw_pointer_derive)]
struct aa_hardware_params {
    font: *const aa_font,
    supported: c_int,
    minwidth: c_int,
    minheight: c_int,
    maxwidth: c_int,
    maxheight: c_int,
    recwidth: c_int,
    recheight: c_int,
    mmwidth: c_int,
    mmheight: c_int,
    width: c_int,
    height: c_int,
    dimmul: c_double,
    boldmul: c_double,
}

#[repr(C)]
struct aa_renderparams;

#[link(name = "aa")]
#[allow(improper_ctypes)]
extern {
    static mem_d: aa_driver;
    static aa_defparams: aa_hardware_params;
    static aa_defrenderparams: aa_renderparams;
    fn aa_init(
        driver: *const aa_driver,
        defparams: *const aa_hardware_params,
        driverdata: *mut c_void) -> *mut aa_context;
    fn aa_close(a: *mut aa_context) -> c_void;
    fn aa_imgwidth(a: *mut aa_context) -> c_int;
    fn aa_imgheight(a: *mut aa_context) -> c_int;
    fn aa_scrwidth(a: *mut aa_context) -> c_int;
    fn aa_scrheight(a: *mut aa_context) -> c_int;
    fn aa_image(a: *mut aa_context) -> *mut c_char;
    fn aa_render(
        c: *mut aa_context,
        p: *const aa_renderparams,
        x1: c_int,
        y1: c_int,
        x2: c_int,
        y2: c_int) -> c_void;
    fn aa_text(a: *mut aa_context) -> *mut c_char;
    // fn aa_attrs(a: *mut aa_context) -> *mut c_char;
}

struct AaContext {
    ctx: *mut aa_context,
    /// Size of the input frames.
    orig_width: usize,
    orig_height: usize,
    /// Text buffer size.
    scr_width: usize,
    scr_height: usize,
    /// Size we need to resize passed frame into.
    /// Note that we don't keep aspect since font aspect usually is not 1:1.
    /// But output image will look ok since aalib transforms 2x2 image pixels
    /// into one character. E.g. for 8x13 font and 1280x720 input frame:
    /// 1280x720 -> 320x110 -> 160x55 (text) -> 160*8x55*13 -> 1280x715.
    img_width: usize,
    img_height: usize,
    /// Scaled image buffer.
    img: Vec<u8>,
}

impl AaContext {
    fn init(
        orig_width: usize, orig_height: usize,
        font_width: usize, font_height: usize,
    ) -> Option<AaContext> {
        let scr_width = orig_width / font_width;
        let scr_height = orig_height / font_height;
        let img_width = scr_width * 2;
        let img_height = scr_height * 2;
        let img = vec![0;img_width*img_height];
        let mut params = aa_defparams.clone();
        params.width = scr_width as c_int;
        params.height = scr_height as c_int;
        unsafe {
            let ctx = aa_init(&mem_d, &params, ptr::null_mut());
            if ctx == ptr::null_mut() {
                None
            } else {
                debug_assert_eq!(aa_scrwidth(ctx), scr_width as c_int);
                debug_assert_eq!(aa_scrheight(ctx), scr_height as c_int);
                debug_assert_eq!(aa_imgwidth(ctx), img_width as c_int);
                debug_assert_eq!(aa_imgheight(ctx), img_height as c_int);
                Some(AaContext {
                    ctx: ctx,
                    orig_width: orig_width,
                    orig_height: orig_height,
                    scr_width: scr_width,
                    scr_height: scr_height,
                    img_width: img_width,
                    img_height: img_height,
                    img: img,
                })
            }
        }
    }

    /// Resample passed gray image frame into preallocated buffer.
    /// Currently bilinear and unoptimized, based on
    /// <http://tech-algorithm.com/articles/bilinear-image-scaling/>.
    fn resize(&mut self, src: &[u8]) {
        // FIXME: Result look awful, close to nearest. Fix that shit. And it's
        // better to use something like Lanczos.
        // FIXME: Avoid bound checks.
        let w1 = self.orig_width;
        let h1 = self.orig_height;
        let w2 = self.img_width;
        let h2 = self.img_height;
        let dst = &mut self.img;
        let x_ratio = w1 as f32 / w2 as f32;
        let y_ratio = h1 as f32 / h2 as f32;
        let mut dst_index = 0;
        for i in 0..h2 {
            let y = (y_ratio * i as f32) as usize;
            let y_frac = (y_ratio * i as f32) % 1.0;
            let y_frac_neg = 1.0 - y_frac;
            for j in 0..w2 {
                let x = (x_ratio * j as f32) as usize;
                let x_frac = (x_ratio * j as f32) % 1.0;
                let x_frac_neg = 1.0 - x_frac;
                let src_index = y * w1 + x;
                let a = src[src_index] as f32;
                let b = src[src_index+1] as f32;
                let c = src[src_index+w1] as f32;
                let d = src[src_index+w1+1] as f32;
                let gray =
                    (a * y_frac_neg + b * y_frac) * x_frac_neg +
                    (c * y_frac_neg + d * y_frac) * x_frac;
                dst[dst_index] = gray as u8;
                dst_index += 1;
            }
        }
    }

    fn render(&mut self, frame: &[u8]) -> &[u8] {
        debug_assert_eq!(frame.len(), self.orig_width * self.orig_height);
        self.resize(frame);
        unsafe {
            let vram = aa_image(self.ctx) as *mut u8;
            ptr::copy_nonoverlapping(self.img.as_ptr(), vram, self.img.len());
            aa_render(
                self.ctx,
                &aa_defrenderparams,
                0,
                0,
                self.scr_width as c_int,
                self.scr_height as c_int);
            slice::from_raw_parts(
                aa_text(self.ctx) as *const u8,
                self.scr_width * self.scr_height)
        }
    }
}

impl Drop for AaContext {
    fn drop(&mut self) {
        unsafe {
            aa_close(self.ctx);
        }
    }
}

const FIRST_ASCII_NUM: usize = 32;  // " "
const LAST_ASCII_NUM: usize = 126;  // "~"

struct Font {
    /// Printable ASCII characters bitmap data (32-126).
    chars: Vec<Vec<u8>>,
    width: usize,
    height: usize,
}

impl Font {
    fn init(opath: Option<&str>, osize: Option<usize>) -> Option<Font> {
        let library = get!(ft::Library::init());
        let face = match opath {
            Some(path) => get!(library.new_face(path, 0)),
            _ => get!(library.new_memory_face(DEFAULT_FONT, 0)),
        };
        match osize {
            Some(size) => get!(face.set_pixel_sizes(0, size as u32)),
            None => {},
        }
        // Build bitmaps of printable ASCII characters of same dimensions, pad
        // if necessary. PCF fonts have same width and height for all glyphs,
        // TTF (even monospaced) need to be adjusted.
        // TODO: Build several bitmap for various text attributes (normal, dim,
        // bold, etc).
        let ch_range = FIRST_ASCII_NUM..LAST_ASCII_NUM+1;
        let mut chars = Vec::with_capacity(ch_range.len());
        let mut width = 0;
        let mut rows = 0;
        for ch in ch_range {
            get!(face.load_char(ch, ft::face::RENDER));
            let glyph = face.glyph();
            let bitmap = glyph.bitmap();
            if width == 0 {
                width = bitmap.width() as usize;
                rows = bitmap.rows() as usize;
                assert!(width > 0);
                assert!(rows > 0);
            } else {
                assert_eq!(width, bitmap.width() as usize);
                assert_eq!(rows, bitmap.rows() as usize);
            }
            let buffer = bitmap.buffer();
            let pitch = bitmap.pitch() as usize;
            // TODO: Negative pitch.
            assert!(pitch > 0, "Negative pitch is not supported.");
            let ch_data = match bitmap.pixel_mode().unwrap() {
                ft::bitmap::PixelMode::Mono => {
                    Self::mono2gray(buffer, width, rows, pitch)
                },
                ft::bitmap::PixelMode::Gray => {
                    // TODO: TTF fonts.
                    panic!("Grayscale fonts are not supported yet.");
                },
                // TODO: Add FT_Bitmap_Convert to freetype-rs.
                p => panic!("Pixel mode {:?} is not supported.", p),
            };
            chars.push(ch_data);
        }
        Some(Font {
            width: width,
            height: rows,
            chars: chars,
        })
    }

    #[inline]
    fn to8(v: u8) -> u8 {
        if v == 0 { 0 } else { 255 }
    }

    // Partial port of FT_Bitmap_Convert from ftbitmap.c
    fn mono2gray(src: &[u8], width: usize, rows: usize, pitch: usize) -> Vec<u8> {
        let mut dst = Vec::with_capacity(width * rows);
        for i in 0..rows {
            let full_bytes = width / 8;
            for j in 0..full_bytes {
                let val = src[i * pitch + j];
                dst.push(Self::to8(val & 0x80));
                dst.push(Self::to8(val & 0x40));
                dst.push(Self::to8(val & 0x20));
                dst.push(Self::to8(val & 0x10));
                dst.push(Self::to8(val & 0x08));
                dst.push(Self::to8(val & 0x04));
                dst.push(Self::to8(val & 0x02));
                dst.push(Self::to8(val & 0x01));
            }
            let remaining_bits = width & 7;
            if remaining_bits > 0 {
                let mut val = src[i * pitch + full_bytes];
                for _ in 0..remaining_bits {
                    dst.push(Self::to8(val & 0x80));
                    val <<= 1;
                }
            }
        }
        debug_assert_eq!(dst.len(), width * rows);
        dst
    }

    fn get_width(&self) -> usize {
        self.width
    }

    fn get_height(&self) -> usize {
        self.height
    }

    fn render(&self, text: &[u8], orig_width: usize, orig_height: usize, out: &mut [u8]) {
        let line_len = orig_width / self.width;
        let nlines = orig_height / self.height;
        let pad_x = orig_width % self.width;
        let pad_y = orig_height % self.height;
        let line_w = self.width * line_len;
        debug_assert_eq!(out.len(), orig_width * orig_height);
        debug_assert_eq!(text.len(),  line_len * nlines);
        // Copy character data into the out buffer row by row:
        //    line_len (4)
        // +---+---+---+---+
        // | t | e | x | t | self.height
        // +---+---+---+---+
        //   ^-- self.width
        // FIXME: Avoid bound checks.
        for nline in 0..nlines {
            let line = &text[line_len*nline .. line_len*(nline+1)];
            for row in 0..self.height {
                let out_base = orig_width * (self.height * nline + row);
                let ch_base = self.width * row;
                for (i, &ch) in line.iter().enumerate() {
                    let ch_data = &self.chars[ch as usize - FIRST_ASCII_NUM];
                    let w = i * self.width;
                    for j in 0..self.width {
                        out[out_base + w + j] = ch_data[ch_base + j];
                    }
                }
                for j in 0..pad_x {
                    out[out_base + line_w + j] = 0;
                }
            }
        }
        // Padding:
        //        line_w     ,- pad_x
        // +---+---+---+---+--+
        // | t | e | x | t |  | self.height
        // +---+---+---+---+--+
        // |   |   |   |   |  | pad_y
        // +---+---+---+---+--+
        for row in 0..pad_y {
            let out_base = orig_width * (self.height * nlines + row);
            for j in 0..orig_width {
                out[out_base + j] = 0;
            }
        }
    }
}

fn run() -> i32 {
    let args: Args = Docopt::new(USAGE)
                            .and_then(|d| d.decode())
                            .unwrap_or_else(|e| e.exit());
    // TODO: It would be better to use e.g. u16 in struct and just let
    // rust-serialize do the rest, but... it converts 65537 to 1.
    // Report that shit to upstream.
    if args.flag_width < 1 || args.flag_height < 1
        || args.flag_width > MAX_SIZE || args.flag_height > MAX_SIZE {
        printerr!("Bad dimensions.");
        return 1;
    }
    let mut infh: Box<io::Read> = if args.arg_path == "-" {
        Box::new(io::stdin())
    } else {
        match File::open(&args.arg_path) {
            Ok(handle) => Box::new(handle),
            Err(err) => {
                printerr!("Can't open input: {}", err);
                return 2;
            },
        }
    };
    let mut outfh = io::stdout();
    let font_path = args.flag_font.as_ref().map(String::as_ref);
    let font = match Font::init(font_path, args.flag_font_size) {
        Some(f) => f,
        _ => {
            printerr!("Can't initialize freetype.");
            return 2;
        },
    };
    let mut aactx = match AaContext::init(
        args.flag_width, args.flag_height,
        font.get_width(), font.get_height(),
    ) {
        Some(ctx) => ctx,
        _ => {
            printerr!("Can't initialize aalib.");
            return 2;
        }
    };
    let bufsize = args.flag_width * args.flag_height * BYTE_DEPTH;
    let mut frame = vec![0;bufsize];
    loop {
        let mut collected = 0;
        while collected < bufsize {
            match infh.read(&mut frame[collected..]) {
                Ok(chunksize) => {
                    if chunksize == 0 {
                        // End of file.
                        if collected > 0 {
                            printerr!("Warning: incomplete input.");
                        }
                        return 0;
                    }
                    collected += chunksize;
                },
                Err(err) => {
                    printerr!("Can't read input: {}", err);
                    return 2;
                },
            }
        }
        let text = aactx.render(&frame);
        font.render(text, args.flag_width, args.flag_height, &mut frame);
        match outfh.write(&frame) {
            Ok(_) => {},
            Err(err) => {
                printerr!("Can't write to stdout: {}", err);
                return 2;
            },
        }
    }
}

fn main() {
    // Hack to call destructors while using custom exit code.
    process::exit(run());
}
