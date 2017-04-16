// ==UserScript==
// @name        0chan webm
// @namespace   https://0chan.hk/webm
// @description Replace external WebM links with video tag.
// @downloadURL https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-webm.user.js
// @updateURL   https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-webm.user.js
// @include     https://0chan.hk/*
// @include     http://nullchan7msxi257.onion/*
// @version     0.0.3
// @grant       none
// ==/UserScript==

// TODO: https://github.com/tsudoko/long-live-pomf/blob/master/long-live-pomf.md
var ALLOWED_LINKS = [
  /^https?:\/\/my\.mixtape\.moe\/.+\.webm$/,
  /^https?:\/\/u\.nya\.is\/.+\.webm$/,
];

function embedVideo(link) {
  var video = document.createElement("video");

  video.style.display = "block";
  video.style.width = "100%";
  video.style.maxHeight = "350px";

  video.loop = true;
  video.controls = true;
  video.src = link.href;

  link.parentNode.replaceChild(video, link);
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
    window.app.$bus.on("refreshContentDone", function() {
      // TODO: Handle multiple threads.
      handleThread(document.querySelector(".thread-tree"));
    });
  });
  observer.observe(container, {childList: true});
}

handleApp(document.body);
