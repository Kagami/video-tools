// ==UserScript==
// @name        0chan webm
// @namespace   https://0chan.hk/webm
// @description Replace external WebM links with video tag.
// @downloadURL https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-webm.user.js
// @updateURL   https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-webm.user.js
// @include     https://0chan.hk/*
// @include     http://nullchan7msxi257.onion/*
// @version     0.0.7
// @grant       GM_xmlhttpRequest
// @grant       unsafeWindow
// @connect     my.mixtape.moe
// @connect     u.nya.is
// @connect     a.safe.moe
// @connect     a.pomf.cat
// @connect     gfycat.com
// @connect     0x0.st
// ==/UserScript==

var ALLOWED_HOSTS = [
  "my.mixtape.moe", "u.nya.is",
  "a.safe.moe", "a.pomf.cat",
  "[a-z]+.gfycat.com",
  "0x0.st",
];
var ALLOWED_LINKS = ALLOWED_HOSTS.map(function(h) {
  return new RegExp("^https?://" + h.replace(/\./g, "\\.") + "/.+\\.webm$");
});

function makeThumbnail(image_data, max_size) {
  return new Promise(function(resolve, reject) {
    var img = document.createElement("img");
    img.addEventListener("load", function (e) {
      var c = document.createElement("canvas");
      var ctx = c.getContext("2d");
      if (img.width > img.height) {
        c.width = max_size;
        c.height = (img.height*max_size) / img.width;
      } else {
        c.width = (img.width*max_size) / img.height;
        c.height = max_size;
      }
      ctx.mozImageSmoothingEnabled = true;
      ctx.webkitImageSmoothingEnabled = true;
      ctx.msImageSmoothingEnabled = true;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, 0, 0, c.width, c.height);
      var arrow = "\u25B6";
      var circle = "\u26AB";
      var text_height = max_size/4;
      ctx.font = text_height + "px Arial";
      ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
      var text_width = ctx.measureText(circle).width;
      ctx.fillText(circle, c.width/2 - text_width*0.55, c.height/2 + text_height*0.45);
      text_height /= 2;
      ctx.font = text_height + "px Arial";
      ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
      text_width = ctx.measureText(arrow).width;
      ctx.fillText(arrow, c.width/2 - text_width/2, c.height/2 + text_height/2);
      resolve(c.toDataURL("image/png", 1.0));
    });
    img.addEventListener("error", reject);
    img.src = image_data;
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

function loadVideo(video_data) {
  return new Promise(function(resolve, reject) {
    var vid = document.createElement("video");
    vid.muted = true;
    vid.autoplay = false;
    vid.addEventListener("error", reject);
    vid.addEventListener("loadedmetadata", function() {
      resolve(vid);
    });
    vid.src = URL.createObjectURL(video_data);
  });
}

function getVideoScreenshot(vid) {
  var timePos = 0.0;
  return new Promise(function(resolve, reject) {
    var makeScreenshot = function() {
      var c = document.createElement("canvas");
      var ctx = c.getContext("2d");
      ctx.mozImageSmoothingEnabled = true;
      ctx.webkitImageSmoothingEnabled = true;
      ctx.msImageSmoothingEnabled = true;
      ctx.imageSmoothingEnabled = true;
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
  .then(function(screenshot) {
    return makeThumbnail(screenshot, 200);
  }).then(function(thumbnail) {
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
      if (!event.target.controls) event.target.play();
      event.target.controls = true;
      event.target.style.maxWidth = "none";
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

function handleApp(container) {
  var observer = new MutationObserver(function(mutations) {
    // XXX: $bus is not yet available on DOMContentLoaded so wait for
    // the first mutation.
    observer.disconnect();
    unsafeWindow.app.$bus.on("refreshContentDone", function() {
      // TODO: Handle multiple threads.
      handleThread(document.querySelector(".thread-tree"));
    });
  });
  observer.observe(container, {childList: true});
}

handleApp(document.body);
