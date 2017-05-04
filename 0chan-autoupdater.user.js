// ==UserScript==
// @name        0chan autoupdater
// @namespace   https://0chan.hk/autoupdater
// @description Autoupdate 0chan threads.
// @downloadURL https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-autoupdater.user.js
// @updateURL   https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-autoupdater.user.js
// @include     https://0chan.hk/*
// @include     http://nullchan7msxi257.onion/*
// @version     0.0.6
// @grant       none
// ==/UserScript==

var UPDATE_INTERVAL = 15 * 1000;

var updateBtn = null;
var inThread = false;
var tid = null;
var unread = 0;
var observePosting = null;
var ignorePosting = null;

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
      n = Math.min(n, 9);
      // TODO: Wait for favicon load?
      ctx.drawImage(orig, 0, 0);
      ctx.fillStyle = "#f00";
      ctx.fillRect(8, 5, 8, 11);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 12px sans-serif";
      ctx.fillText(n, 8, 15);
      link.href = c.toDataURL();
    },
    reset: function() {
      link.href = origURL;
    },
  };
})();

function update() {
  updateBtn.click();
  tid = setTimeout(update, UPDATE_INTERVAL);
}

function initUpdater() {
  if (inThread && document.hidden && tid == null) {
    observePosting();
    tid = setTimeout(update, UPDATE_INTERVAL);
  }
}

function clearUpdater() {
  if (tid != null) {
    clearTimeout(tid);
    tid = null;
    unread = 0;
    Favicon.reset();
    ignorePosting();
  }
}

function handleVisibility() {
  if (document.hidden) {
    initUpdater();
  } else {
    clearUpdater();
  }
}

function handlePosting(container) {
  var observer = new MutationObserver(function(mutations) {
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

  observePosting = function() {
    observer.observe(container, {childList: true, subtree: true});
  };
  ignorePosting = function() {
    observer.disconnect();
  };
}

function handleNavigation() {
  var thread = document.querySelector(".threads");
  clearUpdater();
  updateBtn = null;
  observePosting = null;
  ignorePosting = null;
  if (thread) {
    updateBtn = thread.querySelector(":scope > .btn-group > .btn-default");
    inThread = true;
    handlePosting(thread);
    initUpdater();
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
