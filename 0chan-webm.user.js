// ==UserScript==
// @name        0chan webm
// @namespace   https://0chan.hk/webm
// @description Replace external WebM links with video tag.
// @downloadURL https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-webm.user.js
// @updateURL   https://raw.githubusercontent.com/Kagami/video-tools/master/0chan-webm.user.js
// @include     https://0chan.hk/*
// @include     http://nullchan7msxi257.onion/*
// @version     0.0.1
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
  video.style.maxHeight = "400px";

  video.loop = true;
  video.controls = true;
  video.src = link.href;

  link.parentNode.replaceChild(video, link);
}

// TODO: Handle OP post.
function handlePost(post) {
  var links = post.querySelectorAll("a[target=_blank]");
  Array.prototype.filter.call(links, function(link) {
    return ALLOWED_LINKS.some(function(re) {
      return re.test(link.href);
    });
  }).forEach(embedVideo);
}

function handleContent(content) {
  var container = content.querySelector(".thread-tree");
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
    mutations.find(function(mutation) {
      if (mutation.target.id === "content") {
        observer.disconnect();
        handleContent(mutation.target);
        return true;
      }
    });
  });
  observer.observe(container, {childList: true, subtree: true});
}

handleApp(document.body);
