#!/usr/bin/env python

"""
compare videos frame by frame and draw nice graph

dependencies:
  Python 2.7+ or 3.2+
  FFmpeg 2+
  matplotlib

examples:
  # Compare two videos using SSIM
  python {title} -ref orig.mkv 1.mkv 2.mkv
  # Fix ref resolution
  python {title} -ref orig.mkv -refvf scale=640:-1 1.mkv
  # Show time on x axis
  python {title} -ref orig.mkv -r ntsc-film 1.mkv 2.mkv
"""

# Since there is no way to wrap future imports in try/except, we use
# hack with comment. See <http://stackoverflow.com/q/388069> for
# details.
from __future__ import division  # Install Python 2.7+ or 3.2+
from __future__ import print_function  # Install Python 2.7+ or 3.2+
from __future__ import unicode_literals  # Install Python 2.7+ or 3.2+

import os
import re
import sys
import math
import shlex
import locale
import argparse
import tempfile
import traceback
import subprocess
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker


__title__ = 'cmpv.py'
__version__ = '0.0.0'
__license__ = 'CC0'


_PY2 = sys.version_info[0] == 2
_WIN32 = sys.platform == 'win32'
# We can't use e.g. ``sys.stdout.encoding`` because user can redirect
# the output so in Python2 it would return ``None``. Seems like
# ``getpreferredencoding`` is the best remaining method.
# NOTE: Python 3 uses ``getfilesystemencoding`` in ``os.getenv`` and
# ``getpreferredencoding`` in ``subprocess`` module.
# XXX: We will fail early with ugly traceback on any of this toplevel
# decodes if encoding is wrong.
OS_ENCODING = locale.getpreferredencoding() or 'utf-8'
ARGS = sys.argv[1:]
# In Python2 ``sys.argv`` is a list of bytes. See:
# <http://stackoverflow.com/q/4012571>,
# <https://bugs.python.org/issue2128> for details.
if _PY2: ARGS = [arg.decode(OS_ENCODING) for arg in ARGS]
# Python3 returns unicode here fortunately.
FFMPEG_PATH = os.getenv('VTOOLS_FFMPEG', 'ffmpeg')
if _PY2: FFMPEG_PATH = FFMPEG_PATH.decode(OS_ENCODING)


def run_ffmpeg(args, check_code=True):
    args = [FFMPEG_PATH] + args
    try:
        p = subprocess.Popen(args)
    except Exception as exc:
        raise Exception('failed to run FFmpeg ({})'.format(exc))
    p.communicate()
    if check_code and p.returncode != 0:
        raise Exception('FFmpeg exited with error')
    return {'code': p.returncode}


VIDEO_RATES = {
    'ntsc':  30000/1001,
    'pal':  25/1,
    'qntsc':  30000/1001,
    'qpal':  25/1,
    'sntsc':  30000/1001,
    'spal':  25/1,
    'film':  24/1,
    'ntsc-film':  24000/1001,
}

def get_opts():
    doc = __doc__.format(title=__title__)
    parser = argparse.ArgumentParser(
        prog=__title__,
        description=doc,
        formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument(
        '-V', '--version',
        action='version',
        version='%(prog)s ' + __version__)
    parser.add_argument(
        '-v', action='store_true', dest='verbose',
        help='enable verbose mode')
    parser.add_argument(
        'inpaths', nargs='+',
        help='path to the input file(s), e.g. in.mkv\n'
             'or already collected logs, e.g. /tmp/cmpv-123.log\n'
             '(required)')
    parser.add_argument(
        '-k', action='store_true', dest='keep_logs',
        help='keep collected metric logs for additional use')
    parser.add_argument(
        '-ref', dest='refpath', metavar='refpath',
        help='reference (original) path, e.g. orig.mkv\n'
             '(required unless log files are provided in input)')
    parser.add_argument(
        '-o', dest='graphpath', metavar='graphpath', default='graph.png',
        help='destination graph path (default: %(default)s)')
    parser.add_argument(
        '-t', dest='duration', metavar='duration',
        help='limit the duration of data read from the input file\n'
             'duration may be a number in seconds, or in hh:mm:ss[.xxx] form')
    parser.add_argument(
        '-r', dest='fps', metavar='fps',
        help='show timestamps on graph instead of frame numbers\n'
             'using given video rate, e.g. ntsc-film, ntsc or just 60.0\n'
             'see ffmpeg-utils(1) for recognized list of abbreviations')
    parser.add_argument(
        '-mainvf', metavar='filters',
        help='filters to preprocess main files, e.g. vflip,crop=800:600')
    parser.add_argument(
        '-refvf', metavar='filters',
        help='filters to preprocess reference, e.g. scale=-1:360')
    parser.add_argument(
        '-fo', dest='ffmpegopts', metavar='ffmpegopts',
        help='additional raw FFmpeg options,\n'
             "e.g -fo='-frames 100' (equal sign is mandatory)")
    parser.add_argument(
        '-mainfo', dest='main_ffmpegopts', metavar='ffmpegopts',
        help='raw FFmpeg options to insert before main files,\n'
             "e.g. -mainfo='-r 8' (equal sign is mandatory)")
    parser.add_argument(
        '-reffo', dest='ref_ffmpegopts', metavar='ffmpegopts',
        help='raw FFmpeg options to insert before reference,\n'
             "e.g. -reffo='-itsoffset 10' (equal sign is mandatory)")
    opts = parser.parse_args(ARGS)
    # Additional options processing.
    for inpath in opts.inpaths:
        if not inpath.endswith('.log') and opts.refpath is None:
            parser.error('no log for {}, reference is required'.format(inpath))
    if opts.fps is not None:
        try:
            opts.fps = VIDEO_RATES[opts.fps]
        except KeyError:
            try:
                opts.fps = float(opts.fps)
            except ValueError:
                parser.error('bad fps')
    return opts


if _WIN32:
    def log_info(line):
        print('[i] {}'.format(line), file=sys.stderr)

    def log_result(line):
        print('==> {}'.format(line), file=sys.stderr)
else:
    class TERM_COLORS(object):
        green = '\033[32m'
        bgblue = '\033[44m'
        reset = '\033[0m'

    def log_info(line):
        print('{} i {} {}'.format(
            TERM_COLORS.bgblue,
            TERM_COLORS.reset,
            line), file=sys.stderr)

    def log_result(line):
        print('{}==>{} {}'.format(
            TERM_COLORS.green,
            TERM_COLORS.reset,
            line), file=sys.stderr)


def collect_logs(opts):
    # See ffmpeg-filters(1), "Notes on filtergraph escaping".
    def escape_ffarg(arg):
        arg = arg.replace('\\', r'\\')      # \ -> \\
        arg = arg.replace("'",  r"'\\\''")  # ' -> '\\\''
        arg = arg.replace(':',  r'\:')      # : -> \:
        return arg

    # TODO: Different metrics? ffmpeg currently has only PSNR (horrible
    # metric) and SSIM (we use it) unfortunately.
    for inpath in opts.inpaths:
        if inpath.endswith('.log'):
            opts.logpaths.append(inpath)
            continue

        title = os.path.basename(inpath)
        title = os.path.splitext(title)[0]
        # FIXME: mkstemp may use our separator (-) in path too.
        prefix = 'cmpv-{}-'.format(title)
        logfh, logpath = tempfile.mkstemp(prefix=prefix, suffix='.log')
        os.close(logfh)
        opts.logpaths.append(logpath)
        log_info('{}: saving metrics to {}'.format(
            os.path.basename(inpath), logpath))

        # Input.
        ffargs = ['-hide_banner', '-stats']
        if opts.main_ffmpegopts is not None:
            ffargs += shlex.split(opts.main_ffmpegopts)
        ffargs += ['-i', inpath]
        if opts.ref_ffmpegopts is not None:
            ffargs += shlex.split(opts.ref_ffmpegopts)
        ffargs += ['-i', opts.refpath]
        # Filters.
        if opts.refvf is not None or opts.mainvf is not None:
            mainvf = 'null' if opts.mainvf is None else opts.mainvf
            refvf = 'null' if opts.refvf is None else opts.refvf
            prevf = '[0:v]{}[main];[1:v]{}[ref];[main][ref]'.format(
                mainvf,
                refvf)
        else:
            prevf = ''
        vf = prevf + "ssim=f='{}'".format(escape_ffarg(logpath))
        ffargs += ['-lavfi', vf]
        # Other.
        ffargs += ['-map', 'v']
        ffargs += ['-loglevel', 'info' if opts.verbose else 'error']
        if opts.duration is not None:
            ffargs += ['-t', opts.duration]
        if opts.ffmpegopts is not None:
            ffargs += shlex.split(opts.ffmpegopts)
        ffargs += ['-f', 'null', '-']
        run_ffmpeg(ffargs)


def parse_log(opts, path, metric_type):
    def parse_line(line):
        n, ssimv, db = re.search(
            r'\bn:(\d+)\s.*'
            r'\bAll:(\d+(?:\.\d+)?)\s.*'
            r'\((inf|\d+(?:\.\d+)?)\)',
            line).groups()
        return int(n), float(ssimv), float(db)

    # See libavfilter/vf_ssim.c for details.
    def ssim_db(ssim, weight):
        return 10 * (math.log(weight, 10) - math.log(weight - ssim, 10))

    def get_title():
        name = os.path.basename(path)
        title = os.path.splitext(name)[0]
        if title.startswith('cmpv-'):
            title = title.split('-', 1)[1]
            title = title.rsplit('-', 1)[0]
        if not title:
            title = name
        return title

    try:
        assert metric_type == 'SSIM', 'Unsupported metric'
        data = open(path, 'rb').read().decode('utf-8').strip()
        assert data, 'Empty log ({})'.format(path)
        lines = [parse_line(line) for line in data.split('\n')]
        xs = [line[0] for line in lines]
        ys = [line[2] for line in lines]
        msum = sum(line[1] for line in lines)
        mavg = ssim_db(msum, len(lines))
        return {
            'title': get_title(),
            'type': metric_type,
            'xs': xs,
            'ys': ys,
            'avg': mavg,
        }
    except Exception as exc:
        if opts.verbose:
            exc = '\n\n' + traceback.format_exc()[:-1]
        raise Exception('Cannot parse {}: {}'.format(path, exc))


TABLEAU20_COLORS = [
    (31, 119, 180), (255, 127, 14), (174, 199, 232), (255, 187, 120),
    (44, 160, 44), (152, 223, 138), (214, 39, 40), (255, 152, 150),
    (148, 103, 189), (197, 176, 213), (140, 86, 75), (196, 156, 148),
    (227, 119, 194), (247, 182, 210), (127, 127, 127), (199, 199, 199),
    (188, 189, 34), (219, 219, 141), (23, 190, 207), (158, 218, 229),
]

MAX_POINTS = 250

def draw_graph(opts, metrics):
    def timestamp(n, pos):
        t = int((n - 1) / opts.fps)
        return '{:02d}:{:02d}:{:02d}'.format(t//3600, t%3600//60, t%60)

    # TODO: Allow custom labels, size, density, etc.
    fig, ax = plt.subplots(figsize=(20, 12))
    for i, mdata in enumerate(metrics):
        assert mdata['type'] == 'SSIM', 'Unsupported metric'
        r, g, b = TABLEAU20_COLORS[i % len(TABLEAU20_COLORS)]
        color = r/255, g/255, b/255
        xs, ys = mdata['xs'], mdata['ys']
        if len(xs) > MAX_POINTS:
            ratio = int(len(xs) / MAX_POINTS)
            xs = xs[::ratio]
            ys = ys[::ratio]
        ax.plot(xs, ys, lw=2, color=color)
        # FIXME: Detect overlapping.
        ax.text(xs[-1] + 3, ys[-1] - 0.05, mdata['title'],
                color=color, size=11)
        ax.text(xs[-1] + 3, ys[-1] - 0.40, '{:.3f} avg'.format(mdata['avg']),
                color=color, size=9)
    title = ' vs '.join(mdata['title'] for mdata in metrics)
    ax.set_title(title, size=19)
    ax.set_xlim(left=1)
    if opts.fps is not None:
        fmt = mticker.FuncFormatter(timestamp)
        ax.xaxis.set_major_formatter(fmt)
        loc = mticker.MaxNLocator(nbins=10)
        ax.xaxis.set_major_locator(loc)
        ax.set_xlabel('Time (s)', size=14)
    else:
        ax.set_xlabel('Frame (n)', size=14)
    ax.set_ylabel('SSIM (dB)', size=14)
    ax.xaxis.get_major_ticks()[0].set_visible(False)
    ax.yaxis.get_major_ticks()[0].set_visible(False)
    ax.tick_params(size=0, labelsize=11)
    ax.spines['right'].set_visible(False)
    ax.spines['top'].set_visible(False)
    ax.grid()
    ax.get_ygridlines()[-1].set_visible(False)
    return fig


def cleanup(opts):
    try:
        if not opts.keep_logs:
            log_result('Removing logs')
            [os.remove(logpath) for logpath in opts.logpaths]
    except Exception as exc:
        if opts.verbose:
            exc = '\n\n' + traceback.format_exc()[:-1]
        print('Error during cleanup: {}'.format(exc), file=sys.stderr)


def main():
    opts = get_opts()
    # NOTE: It's a bit kludgy to store temporary variables in options
    # object but otherwise we won't cleanup logs if error occured in the
    # middle of process.
    opts.logpaths = []
    try:
        collect_logs(opts)
        metrics = [
            parse_log(opts, path=logpath, metric_type='SSIM')
            for logpath in opts.logpaths
        ]
        assert metrics, 'Empty metrics'
        fig = draw_graph(opts, metrics=metrics)
        log_result('Saving {}'.format(os.path.basename(opts.graphpath)))
        fig.savefig(opts.graphpath, bbox_inches='tight')
    except Exception as exc:
        if opts.verbose:
            exc = '\n\n' + traceback.format_exc()[:-1]
        err = 'Cannot proceed due to the following error: {}'.format(exc)
        sys.exit(err)
    except KeyboardInterrupt:
        sys.exit('Aborted')
    finally:
        cleanup(opts)


if __name__ == '__main__':
    main()
