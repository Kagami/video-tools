// ==UserScript==
// @name        WebM title
// @namespace   https://2ch.hk/webm-title
// @description Show metadata title of WebM videos at 2ch.hk
// @downloadURL https://raw.githubusercontent.com/Kagami/video-tools/master/webm-title.user.js
// @updateURL   https://raw.githubusercontent.com/Kagami/video-tools/master/webm-title.user.js
// @include     https://2ch.hk/*
// @include     https://2ch.pm/*
// @version     0.0.4
// @grant       none
// ==/UserScript==

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
  return null;
}

function fetchData(url) {
  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.setRequestHeader("Range", "bytes=0-9999");
    xhr.responseType = "arraybuffer";
    xhr.onload = function() {
      if (this.status >= 200 && this.status < 400) {
        resolve(new Uint8Array(this.response));
      } else {
        reject(new Error(this.responseText));
      }
    };
    xhr.onerror = reject;
    xhr.send();
  });
}

function initObserver() {
  var container = document.getElementById("fullscreen-container");
  if (!container) return;
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      Array.prototype.filter.call(mutation.addedNodes, function(node) {
        return node.tagName === "VIDEO";
      }).forEach(function(video) {
        var url = video.querySelector("source").src;
        fetchData(url).then(function(data) {
          var title = parseTitle(data);
          if (!title) return;
          var div = document.createElement("div");
          div.textContent = title;
          div.style.textAlign = "center";
          div.style.fontStyle = "italic";
          div.style.padding = "3px";
          video.parentNode.appendChild(div);
        });
      });
    });
  });
  observer.observe(container, {childList: true});
}

// Makaba API. We need to run _after_ "screenexpand" routine.
// It runs on DOMContentLoaded but Greasemonkey injects callback earlier.
window.Stage("Show webm title", "webmtitle", window.Stage.DOMREADY, initObserver);
