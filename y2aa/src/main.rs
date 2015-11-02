extern crate libc;
extern crate freetype;
extern crate rustc_serialize;
extern crate docopt;

use std::f32;
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
                        Both TrueType and PCF are supported.
  -s, --font-size=<fs>  Font size, required for TrueType fonts.

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
    resizer: Resizer,
    /// Size of the input frames.
    orig_width: usize,
    orig_height: usize,
    /// Text buffer size.
    scr_width: usize,
    scr_height: usize,
    /// Scaled image buffer.
    img: Vec<u8>,
}

impl AaContext {
    fn new(
        orig_width: usize, orig_height: usize,
        font_width: usize, font_height: usize,
    ) -> Option<AaContext> {
        let scr_width = orig_width / font_width;
        let scr_height = orig_height / font_height;
        // Size we need to resize passed frame into.
        // Note that we don't keep aspect since font aspect usually is not
        // 1:1. But output image will look ok since aalib transforms 2x2 image
        // pixels into one character. E.g. for 8x13 font and 1280x720 input
        // frame: 1280x720 -> 320x110 -> 160x55(text) -> 160*8x55*13 ->
        // 1280x715.
        let img_width = scr_width * 2;
        let img_height = scr_height * 2;
        let resizer = Resizer::new(orig_width, orig_height, img_width, img_height);
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
                    resizer: resizer,
                    orig_width: orig_width,
                    orig_height: orig_height,
                    scr_width: scr_width,
                    scr_height: scr_height,
                    img: img,
                })
            }
        }
    }

    fn render(&mut self, frame: &[u8]) -> &[u8] {
        debug_assert_eq!(frame.len(), self.orig_width * self.orig_height);
        self.resizer.run(frame, &mut self.img);
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

/// Simple resampler with preallocated buffers and coeffecients for the given
/// dimensions. See also:
/// * https://github.com/sekrit-twc/zimg/tree/master/src/zimg/resize
/// * https://github.com/PistonDevelopers/image/blob/master/src/imageops/sample.rs
struct Resizer {
    /// Source/target dimensions.
    w1: usize,
    w2: usize,
    h2: usize,
    /// Temporary/preallocated stuff.
    tmp: Vec<u8>,
    coeffs_w: Vec<CoeffsLine>,
    coeffs_h: Vec<CoeffsLine>,
}

struct CoeffsLine {
    left: usize,
    data: Vec<f32>,
}

impl Resizer {
    fn new(w1: usize, h1: usize, w2: usize, h2: usize) -> Resizer {
        Resizer {
            w1: w1,
            w2: w2,
            h2: h2,
            tmp: vec![0;w1*h2],
            coeffs_w: Self::calc_coeffs(w1, w2),
            coeffs_h: Self::calc_coeffs(h1, h2),
        }
    }

    fn calc_coeffs(s1: usize, s2: usize) -> Vec<CoeffsLine> {
        // Use only fixed kernel for now.
        let filter_kernel = Self::lanczos3_kernel;
        let filter_support = 3.0;
        let ratio = s1 as f32 / s2 as f32;
        // Scale the filter when downsampling.
        let filter_scale = if ratio > 1.0 { ratio } else { 1.0 };
        let filter_radius = (filter_support * filter_scale).ceil();
        let mut coeffs = Vec::with_capacity(s2);
        for x2 in 0..s2 {
            let x1 = (x2 as f32 + 0.5) * ratio - 0.5;
            let left = (x1 - filter_radius).ceil() as isize;
            let left = Self::clamp(left, 0, s1 as isize - 1) as usize;
            let right = (x1 + filter_radius).floor() as isize;
            let right = Self::clamp(right, 0, s1 as isize - 1) as usize;
            let mut data = Vec::with_capacity(right - left + 1);
            let mut sum = 0.0;
            for i in left..right+1 {
                sum += filter_kernel((i as f32 - x1) / filter_scale);
            }
            for i in left..right+1 {
                let v = filter_kernel((i as f32 - x1) / filter_scale);
                data.push(v / sum);
            }
            coeffs.push(CoeffsLine {left: left, data: data});
        }
        coeffs
    }

    // #[inline]
    // fn triangle_kernel(x: f32) -> f32 {
    //     f32::max(1.0 - x.abs(), 0.0)
    // }

    #[inline]
    fn sinc(x: f32) -> f32 {
        if x == 0.0 {
            1.0
        } else {
            let a = x * f32::consts::PI;
            a.sin() / a
        }
    }

    #[inline]
    fn lanczos3_kernel(x: f32) -> f32 {
        if x.abs() < 3.0 {
            Self::sinc(x) * Self::sinc(x / 3.0)
        } else {
            0.0
        }
    }

    #[inline]
    fn clamp<N: PartialOrd>(v: N, min: N, max: N) -> N {
        if v <= min {
            min
        } else if v >= max {
            max
        } else {
            v
        }
    }

    /// Branchless clamp. See libyuv/source/row_common.cc
    #[inline]
    fn pack_u8(v: f32) -> u8 {
        let mut v = v.round() as i32;
        v = (-v >> 31) & v;
        v = (((255 - v) >> 31) | v) & 255;
        v as u8
    }

    /// Resample W1xH1 to W1xH2.
    fn sample_rows(&mut self, src: &[u8]) {
        // FIXME: Avoid bound checkings.
        let mut offset = 0;
        for x1 in 0..self.w1 {
            for y2 in 0..self.h2 {
                let ref line = self.coeffs_h[y2];
                let mut accum = 0.0;
                for (i, coeff) in line.data.iter().enumerate() {
                    let y0 = line.left + i;
                    let p = src[y0*self.w1 + x1] as f32;
                    accum += p * coeff;
                }
                self.tmp[offset] = Self::pack_u8(accum);
                offset += 1;
            }
        }
    }

    /// Resample W1xH2 to W2xH2.
    fn sample_cols(&self, dst: &mut [u8]) {
        let mut offset = 0;
        for y2 in 0..self.h2 {
            for x2 in 0..self.w2 {
                let ref line = self.coeffs_w[x2];
                let mut accum = 0.0;
                for (i, coeff) in line.data.iter().enumerate() {
                    let x0 = line.left + i;
                    let p = self.tmp[x0*self.h2 + y2] as f32;
                    accum += p * coeff;
                }
                dst[offset] = Self::pack_u8(accum);
                offset += 1;
            }
        }
    }

    fn run(&mut self, src: &[u8], dst: &mut [u8]) {
        self.sample_rows(src);
        self.sample_cols(dst)
    }
}

const FIRST_ASCII_NUM: usize = 32;  // " "
const LAST_ASCII_NUM: usize = 126;  // "~"

struct Font {
    /// Printable ASCII characters bitmap data (32-126).
    chars: Vec<Vec<u8>>,
    /// Dimensions of each bitmap.
    width: usize,
    height: usize,
}

impl Font {
    fn new(opath: Option<&str>, osize: Option<usize>) -> Option<Font> {
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

    /// Partial port of FT_Bitmap_Convert from ftbitmap.c
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
        //   `-- self.width
        // FIXME: Avoid bound checkings.
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
    // rust-serialize do the rest, but.. it converts 65537 to 1. Report that.
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
    let font = match Font::new(font_path, args.flag_font_size) {
        Some(f) => f,
        _ => {
            printerr!("Can't initialize freetype.");
            return 2;
        },
    };
    let mut aactx = match AaContext::new(
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
