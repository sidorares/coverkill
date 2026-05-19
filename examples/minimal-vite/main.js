const btn = document.getElementById('btn');

function onClick() {
  document.body.classList.add('used');
}

function neverCalled() {
  console.log('this path is never exercised');
}

btn?.addEventListener('click', onClick);
