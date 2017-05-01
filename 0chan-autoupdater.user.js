// ==UserScript==
// @name        0chan autoupdater
// @namespace   https://0chan.hk/autoupdater
// @description Autoupdate 0chan threads.
// @downloadURL https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-autoupdater.user.js
// @updateURL   https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-autoupdater.user.js
// @include     https://0chan.hk/*
// @include     http://nullchan7msxi257.onion/*
// @version     0.0.4
// @grant       none
// ==/UserScript==

var UPDATE_INTERVAL = 15 * 1000;

var updateBtn = null;
var inThread = false;
var tid = null;
var unread = 0;

var Favicon = (function() {
  var c = document.createElement("canvas");
  var ctx = c.getContext("2d");
  var link = document.querySelector("link[rel=icon]");
  var origURL = link.href;
  var orig = new Image();
  orig.addEventListener("load", function() {
    c.width = orig.width;
    c.height = orig.height;
  });
  orig.src = origURL;
  return {
    set: function(n) {
      if (n <= 0) {
        this.reset();
        return;
      }
      n = Math.min(n, 99);
      // TODO: Wait for favicon load?
      ctx.drawImage(orig, 0, 0);
      ctx.fillStyle = "#f00";
      ctx.fillRect(10, 7, 6, 8);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 10px sans-serif";
      ctx.fillText(n, 10, 14);
      link.href = c.toDataURL();
    },
    // TODO: Make sure it's cached.
    reset: function() {
      link.href = origURL;
    },
  };
})();

function update() {
  if (!updateBtn.querySelector(".fa-spin")) {
    updateBtn.click();
  }
  tid = setTimeout(update, UPDATE_INTERVAL);
}

function initUpdater() {
  if (inThread && document.hidden && tid == null) {
    tid = setTimeout(update, UPDATE_INTERVAL);
  }
}

function clearUpdater() {
  clearTimeout(tid);
  tid = null;
  unread = 0;
  Favicon.reset();
}

function handleVisibility() {
  if (document.hidden) {
    initUpdater();
  } else {
    clearUpdater();
  }
}

function handlePosting(container) {
  // TODO: Make sure it's properly GCed.
  var observer = new MutationObserver(function(mutations) {
    if (!document.hidden) return;
    mutations.forEach(function(mutation) {
      Array.prototype.forEach.call(mutation.addedNodes, function(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.parentNode.classList.contains("thread-tree")) {
          unread += 1;
          Favicon.set(unread);
        } else if (node.classList.contains("thread-tree")) {
          unread += node.querySelectorAll(".post").length;
          Favicon.set(unread);
        }
      });
    });
  });
  observer.observe(container, {childList: true, subtree: true});
}

function handleNavigation() {
  var thread = document.querySelector(".threads");
  clearUpdater();
  if (thread) {
    updateBtn = document.querySelector(".threads > .btn-group > .btn-default");
    inThread = true;
    initUpdater();
    handlePosting(thread);
  } else {
    inThread = false;
  }
}

function handleApp(container) {
  var observer = new MutationObserver(function() {
    if (!window.app.$bus) return;
    observer.disconnect();
    window.app.$bus.on("refreshContentDone", handleNavigation);
  });
  observer.observe(container, {childList: true});
}

handleApp(document.body);
document.addEventListener("visibilitychange", handleVisibility);
