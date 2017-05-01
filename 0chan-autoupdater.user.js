// ==UserScript==
// @name        0chan autoupdater
// @namespace   https://0chan.hk/autoupdater
// @description Autoupdate 0chan threads.
// @downloadURL https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-autoupdater.user.js
// @updateURL   https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-autoupdater.user.js
// @include     https://0chan.hk/*
// @include     http://nullchan7msxi257.onion/*
// @version     0.0.1
// @grant       none
// ==/UserScript==

var UPDATE_INTERVAL = 30 * 1000;

var atThread = false;
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
    // TODO: Wait for favicon load?
    set: function(n) {
      if (n <= 0) {
        this.reset();
        return;
      }
      n = Math.min(n, 99);
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
  // console.log("@@@ DOING UPDATE");
  // TODO: Cache button?
  var btn = document.querySelector(".threads > .btn-group > .btn-default");
  if (btn && !btn.querySelector(".fa-spin")) {
    btn.click();
  }
  tid = setTimeout(update, UPDATE_INTERVAL);
}

function initUpdater() {
  // console.log("@@@ TRY INIT UPDATE", atThread, document.hidden, tid);
  if (atThread && document.hidden && tid == null) {
    // console.log("@@@ INIT UPDATE");
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
  document.addEventListener("visibilitychange", function() {
    if (document.hidden) {
      initUpdater();
    } else {
      clearUpdater();
    }
  });
}

function handlePosting(container) {
  // TODO: Make sure it's properly GCed.
  var observer = new MutationObserver(function(mutations) {
    // TODO: Disconnect if visible?
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
    // console.log("@@@ AT THREAD");
    atThread = true;
    initUpdater();
    handlePosting(thread);
  } else {
    atThread = false;
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

handleVisibility();
handleApp(document.body);
