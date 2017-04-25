// ==UserScript==
// @name        0chan webm
// @namespace   https://0chan.hk/webm
// @description Add WebM support to 0chan.
// @downloadURL https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-webm.user.js
// @updateURL   https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-webm.user.js
// @include     https://0chan.hk/*
// @include     http://nullchan7msxi257.onion/*
// @version     0.6.6
// @grant       unsafeWindow
// @grant       GM_xmlhttpRequest
// @grant       GM_setClipboard
// @connect     mixtape.moe
// @connect     u.nya.is
// @connect     a.safe.moe
// @connect     a.pomf.cat
// @connect     gfycat.com
// @connect     0x0.st
// @connect     2ch.hk
// @connect     brchan.org
// @connect     4chan.org
// ==/UserScript==

var LOAD_BYTES1 = 100 * 1024;
var LOAD_BYTES2 = 600 * 1024;
var THUMB_SIZE = 200;
var THUMB_VERSION = 2;
var UPLOAD_HOST = "safe.moe";
var ALLOWED_HOSTS = [
  "[a-z0-9]+.mixtape.moe", "u.nya.is",
  "a.safe.moe", "a.pomf.cat",
  "[a-z0-9]+.gfycat.com",
  "0x0.st",
  "2ch.hk", "brchan.org", "[a-z0-9]+.4chan.org",
];
var ALLOWED_LINKS = ALLOWED_HOSTS.map(function(host) {
  host = host.replace(/\./g, "\\.");
  return new RegExp("^https?://" + host + "/.+\\.(webm|mp4)$");
});

function getContentSize(headers) {
  var range = headers
    .split("\r\n")
    .find(function(h) { return /^content-range:/i.test(h); });
  if (!range) return 0;
  return +range.split("/", 2)[1] || 0;
}

// Ported from 4chan-x (MIT).
function getMatroskaTitle(data) {
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
    cW = Math.floor(cW / 2);
    cH = Math.floor(cH / 2);
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

function showTime(duration) {
  var pad2 = function(n) {
    n |= 0;
    return (n < 10 ? "0" : "") + n;
  };
  return pad2(duration / 60) + ":" + pad2(duration % 60);
}

function getMetadataFromCache(url) {
  var meta = localStorage.getItem("meta_" + url);
  try {
    if (!meta) throw new Error();
    return JSON.parse(meta);
  } catch(e) {
    return {size: 0, width: 0, height: 0, duration: 0, title: ""};
  }
}

function saveMetadataToCache(url, meta) {
  meta = Object.assign({}, getMetadataFromCache(url), meta);
  localStorage.setItem("meta_" + url, JSON.stringify(meta));
}

function loadVideoData(url, limit) {
  return new Promise(function(resolve, reject) {
    GM_xmlhttpRequest({
      url: url,
      method: "GET",
      responseType: "arraybuffer",
      headers: {
        Range: "bytes=0-" + (limit-1),
      },
      onload: function(res) {
        if (res.status >= 200 && res.status < 400) {
          var size = getContentSize(res.responseHeaders);
          saveMetadataToCache(url, {size: size});
          resolve(new Uint8Array(res.response));
        } else {
          reject(new Error("HTTP " + res.status));
        }
      },
      onerror: reject,
    });
  });
}

function loadVideo(url, videoData) {
  return new Promise(function(resolve, reject) {
    var type = url.endsWith(".mp4") ? "video/mp4" : "video/webm";
    var blob = new Blob([videoData], {type: type});
    var blobURL = URL.createObjectURL(blob);
    var vid = document.createElement("video");
    vid.muted = true;
    vid.autoplay = false;
    vid.addEventListener("loadeddata", function() {
      var duration = vid.duration;
      var title = getMatroskaTitle(videoData);
      saveMetadataToCache(url, {duration: duration, title: title});
      resolve(vid);
    });
    vid.addEventListener("error", function() {
      reject(new Error("can't load"));
    });
    vid.src = blobURL;
  });
}

function makeScreenshot(firstPass, url, vid) {
  return new Promise(function(resolve, reject) {
    var c = document.createElement("canvas");
    var ctx = c.getContext("2d");
    var width = c.width = vid.videoWidth;
    var height = c.height = vid.videoHeight;
    if (width <= 0 || width > 4096 || height <= 0 || height > 4096) {
      reject(new Error("bad dimensions"));
      return;
    }
    try {
      ctx.drawImage(vid, 0, 0);
    } catch(e) {
      reject(new Error("can't decode"));
      return;
    }
    // Opera may return black frame if not enough data were loaded.
    if (firstPass) {
      var imgData = ctx.getImageData(0, 0, width, height).data;
      var fullBlack = imgData.every(function(v, i) {
        // [0, 0, 0, 255, 0, 0, 0, 255, ...]
        var rgb = (i + 1) & 3;
        return v === (rgb ? 0 : 255);
      });
      if (fullBlack) {
        reject(new Error("black frame"));
        return;
      }
    }
    saveMetadataToCache(url, {width: width, height: height});
    resolve(c);
  });
}

function makeThumbnail(src) {
  return new Promise(function(resolve, reject) {
    var dst = document.createElement("canvas");
    if (src.width > src.height) {
      dst.width = THUMB_SIZE;
      dst.height = Math.round(THUMB_SIZE * src.height / src.width);
    } else {
      dst.width = Math.round(THUMB_SIZE * src.width / src.height);
      dst.height = THUMB_SIZE;
    }
    resolve(hqDownsampleInPlace(src, dst).toDataURL("image/jpeg"));
  });
}

function getVolumeFromCache() {
  return +localStorage.getItem("webm_volume") || 0;
}

function saveVolumeToCache(volume) {
  localStorage.setItem("webm_volume", volume);
}

function createVideoElement(post, link, thumb) {
  var meta = getMetadataFromCache(link.href);
  var body = post.querySelector(".post-body-message");
  var bodyHeight = body.style.maxHeight;
  var attachments = post.querySelector(".post-inline-attachment");
  var attachHeight = attachments && attachments.style.maxHeight;

  var container = document.createElement("div");
  container.className = "post-img";

  var labels = document.createElement("div");
  labels.className = "post-img-labels";
  var label = document.createElement("span");
  label.className = "post-img-label post-img-gif-label";
  label.textContent = link.href.endsWith(".mp4") ? "MP4" : "WebM";

  var btns = document.createElement("div");
  btns.className = "post-img-buttons";
  var btnCopy = document.createElement("span");
  var iconCopy = document.createElement("i");
  btnCopy.className = "post-img-button";
  iconCopy.className = "fa fa-clipboard";
  btnCopy.title = "Copy title to clipboard";
  btnCopy.addEventListener("click", function() {
    GM_setClipboard(vid.title);
  });

  var caption = document.createElement("figcaption");
  if ((meta.width && meta.height) || meta.size) {
    caption.textContent += meta.width;
    caption.textContent += "×";
    caption.textContent += meta.height;
    caption.textContent += ", ";
    if (meta.size >= 1024 * 1024) {
      caption.textContent += (meta.size / 1024 / 1024).toFixed(2);
      caption.textContent += "Мб";
    } else {
      caption.textContent += (meta.size / 1024).toFixed(2);
      caption.textContent += "Кб";
    }
    if (meta.duration) {
      caption.textContent += ", ";
      caption.textContent += showTime(Math.ceil(meta.duration));
    }
  } else {
    caption.textContent = "неизвестно";
  }

  var expand = function() {
    if (attachments) attachments.style.maxHeight = "none";
    body.style.maxHeight = "none";
    labels.style.display = "none";
    caption.style.display = "none";
    container.replaceChild(vid, a);
    vid.volume = getVolumeFromCache();
    vid.src = link.href;
    vid.play();
  };
  var minimize = function() {
    if (attachments) attachments.style.maxHeight = attachHeight;
    body.style.maxHeight = bodyHeight;
    labels.style.display = "block";
    caption.style.display = "block";
    container.replaceChild(a, vid);
    vid.pause();
    vid.removeAttribute("src");
    vid.load();
  };

  var a = document.createElement("a");
  a.style.display = "block";
  a.style.outline = "none";
  a.title = meta.title;
  a.href = link.href;
  var img = document.createElement("img");
  img.style.display = "block";
  img.src = thumb;
  a.addEventListener("click", function(e) {
    e.preventDefault();
    expand();
  });

  var vid = document.createElement("video");
  vid.style.display = "block";
  vid.style.maxWidth = "100%";
  vid.style.maxHeight = "950px";
  vid.style.cursor = "pointer";
  vid.loop = true;
  vid.controls = true;
  vid.title = meta.title;
  vid.addEventListener("click", function(e) {
    // <https://stackoverflow.com/a/22928167>.
    var ctrlHeight = 50;
    var rect = vid.getBoundingClientRect();
    var relY = e.clientY - rect.top;
    if (relY < rect.height - ctrlHeight) {
      minimize();
    }
  });
  vid.addEventListener("volumechange", function() {
    saveVolumeToCache(vid.volume);
  });

  labels.appendChild(label);
  btnCopy.appendChild(iconCopy);
  btns.appendChild(btnCopy);
  a.appendChild(img);
  container.appendChild(labels);
  if (meta.title) container.appendChild(btns);
  container.appendChild(caption);
  container.appendChild(a);
  return container;
}

function getThumbFromCache(url) {
  var key = "thumb_v" + THUMB_VERSION + "_" + url;
  return localStorage.getItem(key);
}

function saveThumbToCache(url, thumb) {
  var key = "thumb_v" + THUMB_VERSION + "_" + url;
  localStorage.setItem(key, thumb);
}

function embedVideo(post, link) {
  var firstPass = true;
  var cachedThumb = getThumbFromCache(link.href);
  var part1 = function(limit) {
    return loadVideoData(link.href, limit)
      .then(loadVideo.bind(null, link.href))
      .then(makeScreenshot.bind(null, firstPass, link.href))
      .then(makeThumbnail);
  };
  var part2 = function(thumb) {
    return new Promise(function(resolve, reject) {
      var div = createVideoElement(post, link, thumb);
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
        firstPass = false;
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
  }).forEach(embedVideo.bind(null, post));
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
    textarea.value = textarea.value ? (text + "\n" + textarea.value) : text;
  };

  var buttons = container.querySelector(".attachment-btns");
  var button = document.createElement("button");
  button.className = "btn btn-xs btn-default";
  button.style.marginLeft = "3px";
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
      addText(urls.join(" "));
    }, function(e) {
      // TODO: Use notifications.
      addText("upload failed: " + e.message);
    }).then(function() {
      button.disabled = false;
      icon.classList.remove("fa-spinner", "fa-spin", "fa-fw");
      icon.classList.add("fa-file-video-o");
      input.value = null;
      textarea.dispatchEvent(new Event("input"));
    });
  });

  button.appendChild(icon);
  button.appendChild(document.createTextNode(" Прикрепить"));
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
  var observer = new MutationObserver(function() {
    var app = unsafeWindow.app;
    if (!app.$bus) return;
    observer.disconnect();
    app.$bus.on("refreshContentDone", unsafeWindow._webmHandler);
  });
  observer.observe(container, {childList: true});
}

handleApp(document.body);
