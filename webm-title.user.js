// ==UserScript==
// @name        WebM title
// @namespace   https://2chk.hk/webm-title
// @description Show metadata title of WebM videos on 2ch.hk
// @include     https://2ch.hk/*
// @version     0.0.1
// @grant       none
// ==/UserScript==

// Ported from 4chan-x (MIT).
function parseTitle(data) {
  function readInt() {
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
  }

  var i = 0;
  while (i < data.length) {
    var element = readInt();
    var size = readInt();
    if (element === 0x3BA9) {  // Title
      var title = "";
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

document.addEventListener("DOMContentLoaded", function() {
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
}, false);
