// ==UserScript==
// @name        0chan webm
// @namespace   https://0chan.hk/webm
// @description Replace external WebM links with video tag.
// @downloadURL https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-webm.user.js
// @updateURL   https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-webm.user.js
// @include     https://0chan.hk/*
// @include     http://nullchan7msxi257.onion/*
// @version     0.4.6
// @grant       GM_xmlhttpRequest
// @grant       unsafeWindow
// @grant       GM_setClipboard
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
var LOAD_BYTES2 = 600 * 1024;
var THUMB_SIZE = 200;
var THUMB_VERSION = 2;
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

// Ported from 4chan-x (MIT).
function parseTitle(data) {
  var i = 0;
  var element = 0;
  var size = 0;
  var title = "";

  var readInt = function() {
    var n = data[i++];
    var len = 0;
    while (n < (0x80 >> len)) {
      len++;
    }
    n ^= (0x80 >> len);
    while (len-- && i < data.length) {
      n = (n << 8) ^ data[i++];
    }
    return n;
  };

  while (i < data.length) {
    element = readInt();
    size = readInt();
    if (element === 0x3BA9) {  // Title
      while (size-- && i < data.length) {
        title += String.fromCharCode(data[i++]);
      }
      return decodeURIComponent(escape(title));  // UTF-8 decoding
    } else if (element !== 0x8538067 && element !== 0x549A966) {  // Segment, Info
      i += size;
    }
  }

  return "";
}

// See <https://stackoverflow.com/a/17862644>.
function hqDownsampleInPlace(src, dst) {
  var tmp = null;
  var cW = src.width;
  var cH = src.height;
  var dW = dst.width;
  var dH = dst.height;
  do {
    cW /= 2;
    cH /= 2;
    if (cW < dW) cW = dW;
    if (cH < dH) cH = dH;
    dst.width = cW;
    dst.height = cH;
    dst.getContext("2d").drawImage(src, 0, 0, cW, cH);
    tmp = src;
    src = dst;
    dst = tmp;
  } while (cW > dW || cH > dH);
  return src;
}

function makeThumbnail(src) {
  return new Promise(function(resolve, reject) {
    var dst = document.createElement("canvas");
    if (src.width > src.height) {
      dst.width = THUMB_SIZE;
      dst.height = THUMB_SIZE * src.height / src.width;
    } else {
      dst.width = THUMB_SIZE * src.width / src.height;
      dst.height = THUMB_SIZE;
    }
    resolve(hqDownsampleInPlace(src, dst).toDataURL("image/jpeg"));
  });
}

function loadVideoDataFromURL(url, limit) {
  return new Promise(function(resolve, reject) {
    GM_xmlhttpRequest({
      url: url,
      method: "GET",
      responseType: "arraybuffer",
      headers: {
        Range: "bytes=0-" + limit,
      },
      onload: function(res) {
        if (res.status >= 200 && res.status < 400) {
          resolve(new Uint8Array(res.response));
        } else {
          reject(new Error("HTTP " + res.status));
        }
      },
      onerror: reject,
    });
  });
}

function getTitleFromCache(url) {
  return localStorage.getItem("title_" + url);
}

function saveTitleToCache(url, title) {
  localStorage.setItem("title_" + url, title);
}

function loadVideoTitle(url, videoData) {
  return new Promise(function(resolve, reject) {
    var title = parseTitle(videoData);
    if (title) {
      saveTitleToCache(url, title);
    }
    resolve(videoData);
  });
}

function loadVideo(videoData) {
  return new Promise(function(resolve, reject) {
    var blob = new Blob([videoData]);
    var url = URL.createObjectURL(blob);
    var vid = document.createElement("video");
    vid.muted = true;
    vid.autoplay = false;
    vid.addEventListener("error", function() {
      reject(new Error("failed to load"));
    });
    vid.addEventListener("loadeddata", function() {
      resolve(vid);
    });
    vid.src = url;
  });
}

function makeScreenshot(vid) {
  return new Promise(function(resolve, reject) {
    var c = document.createElement("canvas");
    var ctx = c.getContext("2d");
    c.width = vid.videoWidth;
    c.height = vid.videoHeight;
    ctx.drawImage(vid, 0, 0);
    resolve(c);
  });
}

function getVolumeFromCache() {
  return +localStorage.getItem("webm_volume") || 0;
}

function saveVolumeToCache(volume) {
  localStorage.setItem("webm_volume", volume);
}

function createVideoElement(link, thumbnail) {
  var div = document.createElement("div");
  div.className = "post-img";
  div.style.margin = 0;

  var vid = document.createElement("video");
  vid.style.display = "block";
  vid.style.maxWidth = "100%";
  vid.style.maxHeight = "350px";
  vid.style.cursor = "pointer";
  vid.style.border = "1px dashed #818181";
  vid.poster = thumbnail;
  vid.preload = "none";
  vid.loop = true;
  vid.controls = false;
  vid.volume = getVolumeFromCache();
  var title = getTitleFromCache(link.href);
  vid.title = title ? (title + " | " + link.href) : link.href;
  vid.addEventListener("click", function() {
    if (!vid.controls) {
      btns.style.display = "block";
      vid.controls = true;
      vid.play();
    }
  });
  vid.addEventListener("volumechange", function() {
    saveVolumeToCache(vid.volume);
  });
  vid.src = link.href;

  var btns = document.createElement("div");
  btns.className = "post-img-buttons";
  btns.style.display = "none";

  var btn = document.createElement("span");
  var i = document.createElement("i");
  btn.className = "post-img-button";
  i.className = "fa fa-times";
  btn.title = "Minimize video";
  btn.addEventListener("click", function() {
    btns.style.display = "none";
    vid.controls = false;
    vid.src = link.href;
  });

  var btn2 = document.createElement("a");
  var i2 = document.createElement("i");
  btn2.className = "post-img-button";
  i2.className = "fa fa-external-link-square";
  btn2.style.minWidth = 0;
  btn2.style.minHeight = 0;
  btn2.style.color = "#333";
  btn2.href = link.href;
  btn2.setAttribute("target", "_blank");
  btn2.title = "Open video in new tab";
  btn2.addEventListener("click", function() {
    vid.pause();
  });

  var btn3 = document.createElement("span");
  var i3 = document.createElement("i");
  btn3.className = "post-img-button";
  i3.className = "fa fa-clipboard";
  btn3.title = "Copy video title to clipboard";
  btn3.addEventListener("click", function() {
    GM_setClipboard(vid.title);
  });

  btn3.appendChild(i3);
  btns.appendChild(btn3);
  btn2.appendChild(i2);
  btns.appendChild(btn2);
  btn.appendChild(i);
  btns.appendChild(btn);
  div.appendChild(vid);
  div.appendChild(btns);
  return div;
}

function getThumbFromCache(url) {
  var key = "thumb_v" + THUMB_VERSION + "_" + url;
  return localStorage.getItem(key);
}

function saveThumbToCache(url, thumb) {
  var key = "thumb_v" + THUMB_VERSION + "_" + url;
  localStorage.setItem(key, thumb);
}

function embedVideo(link) {
  var cachedThumb = getThumbFromCache(link.href);
  var part1 = function(limit) {
    return loadVideoDataFromURL(link.href, limit)
      .then(loadVideoTitle.bind(null, link.href))
      .then(loadVideo)
      .then(makeScreenshot)
      .then(makeThumbnail);
  };
  var part2 = function(thumb) {
    return new Promise(function(resolve, reject) {
      var div = createVideoElement(link, thumb);
      link.parentNode.replaceChild(div, link);
      if (!cachedThumb) {
        saveThumbToCache(link.href, thumb);
      }
      resolve();
    });
  };
  var partErr = function(e) {
    console.error("[0chan-webm] Failed to embed " + link.href +
                  " : " + e.message);
  };

  if (cachedThumb) {
    part2(cachedThumb).catch(partErr);
  } else {
    part1(LOAD_BYTES1).then(function(thumb) {
      part2(thumb).catch(partErr);
    }, function(e) {
      if ((e.message || "").startsWith("HTTP ")) {
        partErr(e);
      } else {
        part1(LOAD_BYTES2).then(part2).catch(partErr);
      }
    });
  }
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
          resolve(info.files.map(function(f) { return f.url; }));
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
  var addText = function(text) {
    textarea.value += (textarea.value ? "\n" : "") + text;
  };

  var buttons = container.querySelector(".attachment-btns");
  var button = document.createElement("button");
  button.className = "btn btn-xs btn-default";
  button.addEventListener("click", function() {
    input.click();
  });

  var icon = document.createElement("i");
  icon.className = "fa fa-file-video-o";

  var input = document.createElement("input");
  input.style.display = "none";
  input.setAttribute("name", "files");
  input.setAttribute("type", "file");
  input.setAttribute("accept", "video/*");
  input.multiple = true;
  input.addEventListener("change", function() {
    button.disabled = true;
    icon.classList.remove("fa-file-video-o");
    icon.classList.add("fa-spinner", "fa-spin", "fa-fw");
    upload(input.files).then(function(urls) {
      addText(urls.join("\n"));
    }, function(e) {
      // TODO: Use notifications.
      addText("upload fail: " + e.message);
    }).then(function() {
      button.disabled = false;
      icon.classList.remove("fa-spinner", "fa-spin", "fa-fw");
      icon.classList.add("fa-file-video-o");
      input.value = null;
      textarea.dispatchEvent(new Event("input"));
    });
  });

  button.appendChild(icon);
  button.appendChild(document.createTextNode(" WebM"));
  buttons.parentNode.appendChild(input);
  buttons.appendChild(button);
}

function handlePosts(container) {
  Array.prototype.forEach.call(container.querySelectorAll(".post"), handlePost);
}

function handleThread(container) {
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      Array.prototype.forEach.call(mutation.addedNodes, function(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.parentNode.classList.contains("thread-tree") ||
            node.classList.contains("post-popup")) {
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
  handlePosts(container);
  embedUpload(document.querySelector(".reply-form"));
}

function handleThreads() {
  // Class naming is a bit stupid. Thanks Misha.
  var thread = document.querySelector(".threads");
  var threads = document.querySelector(".thread");
  if (thread) {
    handleThread(thread);
  } else if (threads) {
    var container = threads.parentNode.parentNode;
    var observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(mutation) {
        Array.prototype.forEach.call(mutation.addedNodes, function(node) {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          if (node.parentNode === container) {
            handlePosts(node);
          } else if (node.classList.contains("post-popup")) {
            handlePost(node);
          } else if (node.classList.contains("reply-form")) {
            embedUpload(node);
          }
        });
      });
    });
    observer.observe(container, {childList: true, subtree: true});
    handlePosts(container);
    embedUpload(document.querySelector(".reply-form"));
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
