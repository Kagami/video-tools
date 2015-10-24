### cmpv.py

Compare videos frame by frame and draw nice SSIM distribution graph.

![](https://raw.githubusercontent.com/Kagami/video-tools/assets/graph.png)

#### Requirements

* [Python](https://www.python.org/downloads/) 2.7+ or 3.2+
* [FFmpeg](https://ffmpeg.org/download.html) 2+
* [matplotlib](http://matplotlib.org/)

#### Examples

```bash
# Compare two videos using SSIM
python {title} -ref orig.mkv 1.mkv 2.mkv
# Fix ref resolution
python {title} -ref orig.mkv -refvf scale=640:-1 1.mkv
# Show time on x axis
python {title} -ref orig.mkv -r ntsc-film 1.mkv 2.mkv
```

### See also

* [webm.py wiki](https://github.com/Kagami/webm.py/wiki), contains some video-related info
* [webm-thread tools](https://github.com/pituz/webm-thread/tree/master/tools)

### License

video-tools - Various video tools

Written in 2015 by Kagami Hiiragi <kagami@genshiken.org>

To the extent possible under law, the author(s) have dedicated all copyright and related and neighboring rights to this software to the public domain worldwide. This software is distributed without any warranty.

You should have received a copy of the CC0 Public Domain Dedication along with this software. If not, see <http://creativecommons.org/publicdomain/zero/1.0/>.
