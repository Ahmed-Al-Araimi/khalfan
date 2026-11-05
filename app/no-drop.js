/* A file dragged onto Khalfan is never opened in his window: he does not take files. */
'use strict';
(() => {
  const no = (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'; };
  document.addEventListener('dragover', no);
  document.addEventListener('drop', no);
})();
