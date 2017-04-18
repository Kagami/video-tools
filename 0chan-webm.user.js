// ==UserScript==
// @name        0chan webm
// @namespace   https://0chan.hk/webm
// @description Replace external WebM links with video tag.
// @downloadURL https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-webm.user.js
// @updateURL   https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-webm.user.js
// @include     https://0chan.hk/*
// @include     http://nullchan7msxi257.onion/*
// @version     0.0.9
// @grant       GM_xmlhttpRequest
// @grant       unsafeWindow
// @connect     my.mixtape.moe
// @connect     u.nya.is
// @connect     a.safe.moe
// @connect     a.pomf.cat
// @connect     gfycat.com
// @connect     0x0.st
// ==/UserScript==

var THUMB_SIZE = 200;
var ALLOWED_HOSTS = [
  "my.mixtape.moe", "u.nya.is",
  "a.safe.moe", "a.pomf.cat",
  "[a-z]+.gfycat.com",
  "0x0.st",
];
var ALLOWED_LINKS = ALLOWED_HOSTS.map(function(h) {
  return new RegExp("^https?://" + h.replace(/\./g, "\\.") + "/.+\\.webm$");
});

function makeThumbnail(screenshot) {
  return new Promise(function(resolve, reject) {
    var img = document.createElement("img");
    img.addEventListener("load", function () {
      var c = document.createElement("canvas");
      var ctx = c.getContext("2d");
      var arrow = "\u25B6";
      var circle = "\u26AB";
      var textWidth = 0;
      var textHeight = THUMB_SIZE / 4;
      if (img.width > img.height) {
        c.width = THUMB_SIZE;
        c.height = (img.height*THUMB_SIZE) / img.width;
      } else {
        c.width = (img.width*THUMB_SIZE) / img.height;
        c.height = THUMB_SIZE;
      }
      ctx.drawImage(img, 0, 0, c.width, c.height);
      ctx.font = textHeight + "px sans-serif";
      ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
      textWidth = ctx.measureText(circle).width;
      ctx.fillText(circle, c.width/2 - textWidth*0.55, c.height/2 + textHeight*0.45);
      textHeight /= 2;
      ctx.font = textHeight + "px sans-serif";
      ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
      textWidth = ctx.measureText(arrow).width;
      ctx.fillText(arrow, c.width/2 - textWidth/2, c.height/2 + textHeight/2);
      resolve(c.toDataURL("image/png", 1.0));
    });
    img.addEventListener("error", reject);
    img.src = screenshot;
  });
}

function loadVideoDataFromURL(url) {
  return new Promise(function(resolve, reject) {
    GM_xmlhttpRequest({
      method: "GET",
      responseType: "blob",
      url: url,
      headers: {
        Range: "bytes=0-300000"  // Should be enough to get first frame
      },
      onload: function(response) {
        resolve(response.response);
      },
      onerror: function(e) {
        reject(e);
      },
    });
  });
}

function loadVideo(videoData) {
  return new Promise(function(resolve, reject) {
    var vid = document.createElement("video");
    vid.muted = true;
    vid.autoplay = false;
    vid.addEventListener("error", reject);
    vid.addEventListener("loadedmetadata", function() {
      resolve(vid);
    });
    vid.src = URL.createObjectURL(videoData);
  });
}

function getVideoScreenshot(vid) {
  var timePos = 0.0;
  return new Promise(function(resolve, reject) {
    var makeScreenshot = function() {
      var c = document.createElement("canvas");
      var ctx = c.getContext("2d");
      try {
        c.width = vid.videoWidth;
        c.height = vid.videoHeight;
        ctx.drawImage(vid, 0, 0, c.width, c.height);
      } catch (e) {
        reject(e);
        return;
      }
      resolve(c.toDataURL("image/png", 1.0));
    };
    if (vid.currentTime === timePos) {
      var HAVE_CURRENT_DATA = 2;
      var HAVE_METADATA = 1;
      if (vid.readyState >= HAVE_CURRENT_DATA) {
        makeScreenshot();
      } else if (vid.readyState === HAVE_METADATA) {
        vid.addEventListener("error", reject);
        vid.addEventListener("seeked", makeScreenshot);
        vid.currentTime = timePos;
      } else {
        reject(new Error());
      }
    } else {
      vid.addEventListener("error", reject);
      vid.addEventListener("seeked", makeScreenshot);
      vid.currentTime = timePos;
    }
  });
}

function embedVideo(link) {
  loadVideoDataFromURL(link.href)
  .then(loadVideo)
  .then(getVideoScreenshot)
  .then(makeThumbnail)
  .then(function(thumbnail) {
    var vid = document.createElement("video");

    vid.style.display = "block";
    vid.style.maxWidth = "200px";
    vid.style.maxHeight = "350px";

    vid.poster = thumbnail;
    vid.preload = "none";
    vid.loop = true;
    vid.controls = false;
    vid.src = link.href;
    vid.addEventListener("click", function(event) {
      if (!vid.controls) vid.play();
      vid.controls = true;
      vid.style.maxWidth = "none";
    });

    link.parentNode.replaceChild(vid, link);
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

// TODO: Handle OP post.
function handleThread(container) {
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      Array.prototype.filter.call(mutation.addedNodes, function(node) {
        return node.tagName === "DIV";
      }).forEach(handlePost);
    });
  });
  observer.observe(container, {childList: true});
  Array.prototype.forEach.call(container.children, handlePost);
}

unsafeWindow.webmHandler = exportFunction(function() {
  // TODO: Handle multiple threads.
  handleThread(document.querySelector(".thread-tree"));
}, unsafeWindow);

function handleApp(container) {
  var observer = new MutationObserver(function(mutations) {
    // XXX: $bus is not yet available on DOMContentLoaded so wait for
    // the first mutation.
    observer.disconnect();
    unsafeWindow.app.$bus.on("refreshContentDone", unsafeWindow.webmHandler);
  });
  observer.observe(container, {childList: true});
}

handleApp(document.body);
