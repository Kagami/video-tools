// ==UserScript==
// @name        0chan webm
// @namespace   https://0chan.hk/webm
// @description Replace external WebM links with video tag.
// @downloadURL https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-webm.user.js
// @updateURL   https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-webm.user.js
// @include     https://0chan.hk/*
// @include     http://nullchan7msxi257.onion/*
// @version     0.2.9
// @grant       GM_xmlhttpRequest
// @grant       unsafeWindow
// @connect     mixtape.moe
// @connect     u.nya.is
// @connect     a.safe.moe
// @connect     a.pomf.cat
// @connect     gfycat.com
// @connect     0x0.st
// @connect     2ch.hk
// @connect     brchan.org
// ==/UserScript==

var LOAD_BYTES1 = 150 * 1024;
var LOAD_BYTES2 = 500 * 1024;
var THUMB_SIZE = 200;
var UPLOAD_HOST = "safe.moe";
var ALLOWED_HOSTS = [
  "[a-z0-9]+.mixtape.moe", "u.nya.is",
  "a.safe.moe", "a.pomf.cat",
  "[a-z]+.gfycat.com",
  "0x0.st",
  "2ch.hk", "brchan.org",
];
var ALLOWED_LINKS = ALLOWED_HOSTS.map(function(host) {
  host = host.replace(/\./g, "\\.");
  return new RegExp("^https?://" + host + "/.+\\.(webm|mp4)$");
});

function downsample(src, dst) {
  var c1 = document.createElement("canvas");
  var c2 = document.createElement("canvas");
  var tmp = null;
  var cW = c1.width = src.width;
  var cH = c1.height = src.height;
  c1.getContext("2d").drawImage(src, 0, 0, cW, cH);

  do {
    cW /= 2;
    cH /= 2;
    if (cW < dst.width) cW = dst.width;
    if (cH < dst.height) cH = dst.height;
    c2.width = cW;
    c2.height = cH;
    c2.getContext("2d").drawImage(c1, 0, 0, cW, cH);
    tmp = c1;
    c1 = c2;
    c2 = tmp;
  } while (cW > dst.width || cH > dst.height);

  dst.getContext("2d").drawImage(c1, 0, 0);
}

function makeThumbnail(screenshot) {
  return new Promise(function(resolve, reject) {
    var img = document.createElement("img");
    img.addEventListener("load", function () {
      var arrow = "\u25B6";
      var textWidth = 0;
      var textHeight = 40;
      var c = document.createElement("canvas")
      var ctx = c.getContext("2d");

      if (img.width > img.height) {
        c.width = THUMB_SIZE;
        c.height = THUMB_SIZE * img.height / img.width;
      } else {
        c.width = THUMB_SIZE * img.width / img.height;
        c.height = THUMB_SIZE;
      }
      downsample(img, c);

      ctx.font = textHeight + "px sans-serif";
      ctx.fillStyle = "#6cbf1d";
      ctx.strokeStyle = "#366a04";
      textWidth = ctx.measureText(arrow).width;
      ctx.fillText(arrow, c.width / 2 - textWidth / 2, c.height / 2 + 15);
      ctx.lineWidth = 2;
      ctx.strokeText(arrow, c.width / 2 - textWidth / 2, c.height / 2 + 15);
      resolve(c.toDataURL("image/png", 1.0));
    });
    img.addEventListener("error", reject);
    img.src = screenshot;
  });
}

function loadVideoDataFromURL(url, limit) {
  return new Promise(function(resolve, reject) {
    GM_xmlhttpRequest({
      url: url,
      method: "GET",
      responseType: "blob",
      headers: {
        Range: "bytes=0-" + limit,
      },
      onload: function(res) {
        if (res.status >= 200 && res.status < 400) {
          resolve(res.response);
        } else {
          reject(new Error("HTTP " + res.status));
        }
      },
      onerror: reject,
    });
  });
}

function loadVideo(videoData) {
  return new Promise(function(resolve, reject) {
    var vid = document.createElement("video");
    vid.muted = true;
    vid.autoplay = false;
    vid.addEventListener("error", function() {
      reject(new Error("failed to load"));
    });
    vid.addEventListener("loadeddata", function() {
      resolve(vid);
    });
    vid.src = URL.createObjectURL(videoData);
  });
}

function getVideoScreenshot(vid) {
  return new Promise(function(resolve, reject) {
    var c = document.createElement("canvas");
    var ctx = c.getContext("2d");
    c.width = vid.videoWidth;
    c.height = vid.videoHeight;
    ctx.drawImage(vid, 0, 0, c.width, c.height);
    resolve(c.toDataURL("image/png", 1.0));
  });
}

function createVideoElement(link, thumbnail) {
  var div = document.createElement("div");
  div.className = "post-img";

  var vid = document.createElement("video");
  vid.style.display = "block";
  vid.style.maxHeight = "350px";
  vid.style.cursor = "pointer";
  vid.style.border = "1px dashed #818181";
  vid.poster = thumbnail;
  vid.preload = "none";
  vid.loop = true;
  vid.controls = false;
  vid.title = link.href;
  vid.addEventListener("click", function() {
    if (!vid.controls) {
      close.style.display = "block";
      vid.controls = true;
      vid.play();
    }
  });
  vid.src = link.href;

  var close = document.createElement("div");
  var span = document.createElement("span");
  var i = document.createElement("i");
  close.className = "post-img-buttons";
  span.className = "post-img-button";
  i.className = "fa fa-times";
  close.style.display = "none";
  close.addEventListener("click", function() {
    close.style.display = "none";
    vid.controls = false;
    vid.src = link.href;
  });

  div.appendChild(vid);
  span.appendChild(i);
  close.appendChild(span);
  div.appendChild(close);
  return div;
}

function embedVideo(link) {
  var part1 = function(limit) {
    return loadVideoDataFromURL(link.href, limit)
      .then(loadVideo)
      .then(getVideoScreenshot);
  };
  var part2 = function(screenshot) {
    return makeThumbnail(screenshot).then(function(thumbnail) {
      var div = createVideoElement(link, thumbnail);
      link.parentNode.replaceChild(div, link);
    });
  };
  var partErr = function(e) {
    console.error("[0chan-webm] Failed to embed " + link.href +
                  " : " + e.message);
  };

  part1(LOAD_BYTES1).then(function(screenshot) {
    part2(screenshot).catch(partErr);
  }, function(e) {
    if ((e.message || "").startsWith("HTTP ")) {
      partErr(e);
    } else {
      part1(LOAD_BYTES2).then(part2).catch(partErr);
    }
  });
}

function handlePost(post) {
  var links = post.querySelectorAll("a[target=_blank]");
  Array.prototype.filter.call(links, function(link) {
    return ALLOWED_LINKS.some(function(re) {
      return re.test(link.href);
    });
  }).forEach(embedVideo);
}

function upload(files) {
  return new Promise(function(resolve, reject) {
    var url = "https://" + UPLOAD_HOST + "/api/upload";
    var form = new FormData();
    Array.prototype.forEach.call(files, function(file) {
      form.append("files[]", file);
    });
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.onload = function() {
      if (this.status >= 200 && this.status < 400) {
        var info = JSON.parse(this.responseText);
        if (info.success) {
          var urls = info.files.map(function(f) { return f.url; }).join("\n");
          resolve(urls);
        } else {
          reject(new Error(info.description.code));
        }
      } else {
        reject(new Error(this.status));
      }
    };
    xhr.onerror = reject;
    xhr.send(form);
  });
}

function embedUpload(container) {
  var textarea = container.querySelector("textarea");
  var buttons = container.querySelector(".attachment-btns");

  var button = document.createElement("button");
  button.className = "btn btn-xs btn-default";
  button.textContent = "WebM";
  button.addEventListener("click", function() {
    input.click();
  });

  var input = document.createElement("input");
  input.style.display = "none";
  input.setAttribute("name", "files");
  input.setAttribute("type", "file");
  input.setAttribute("accept", "video/*");
  input.multiple = true;
  input.addEventListener("change", function() {
    button.disabled = true;
    textarea.value = "uploading…";
    upload(input.files).then(function(urls) {
      textarea.value = urls;
    }, function(e) {
      textarea.value = "failed to upload: " + e.message;
    }).then(function() {
      button.disabled = false;
      input.value = null;
      textarea.dispatchEvent(new Event("input"));
    });
  });

  buttons.appendChild(input);
  buttons.appendChild(button);
}

function embedMainUpload() {
  var container = document.querySelector(".reply-form")
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      var nodes = mutation.addedNodes;
      var replaced = Array.prototype.some.call(nodes, function(node) {
        return node.classList.contains("reply-form");
      });
      if (replaced) {
        embedUpload(container);
      }
    });
  });
  observer.observe(container.parentNode, {childList: true});
  embedUpload(container);
}

function handleThread(container) {
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      Array.prototype.forEach.call(mutation.addedNodes, function(node) {
        if (node.parentNode.classList.contains("thread-tree")) {
          handlePost(node);
        } else if (node.classList.contains("reply-form")) {
          embedUpload(node);
        } else if (node.classList.contains("thread-tree")) {
          Array.prototype.forEach.call(node.querySelectorAll(".post"), handlePost);
        }
      });
    });
  });
  observer.observe(container, {childList: true, subtree: true});
  Array.prototype.forEach.call(container.querySelectorAll(".post"), handlePost);
  embedMainUpload();
}

// TODO: Handle multiple threads.
function handleThreads() {
  var thread = document.querySelector(".threads");
  if (thread) {
    handleThread(thread);
  }
}

unsafeWindow._webmHandler = typeof exportFunction === "undefined"
  ? handleThreads
  : exportFunction(handleThreads, unsafeWindow);

function handleApp(container) {
  var observer = new MutationObserver(function(mutations) {
    var app = unsafeWindow.app;
    if (!app.$bus) return;
    observer.disconnect();
    app.$bus.on("refreshContentDone", unsafeWindow._webmHandler);
  });
  observer.observe(container, {childList: true});
}

handleApp(document.body);
