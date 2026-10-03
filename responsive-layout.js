(function () {
  'use strict';

  const app = document.getElementById('app');
  if (!app) return;
  const legacyUnits = !window.CSS?.supports('width', '1cqw');
  if (legacyUnits) {
    // Earlier console browsers can size the same board using measured units.
    // Convert the original stylesheet once, keeping all its board details.
    for (const style of document.head.querySelectorAll('style')) {
      style.textContent = style.textContent.replace(/url\([^)]*\)|(-?(?:\d+(?:\.\d+)?|\.\d+))cq([wh])\b/g,
        (token, amount, axis) => amount === undefined ? token : `calc(${amount} * var(--container-unit-${axis === 'w' ? 'width' : 'height'}, 1px))`);
    }
  }
  const toolbar = document.createElement('header');
  toolbar.id = 'appToolbar';
  toolbar.className = 'app-toolbar';
  toolbar.setAttribute('aria-label', 'Game and account controls');
  document.body.insertBefore(toolbar, app);

  let stage = null;
  let modal = null;
  let hud = null;
  let frame = 0;
  let boardFrame = 0;
  let footerSpace = 0;
  let toolbarSpace = 0;

  function queueRefresh() {
    if (!frame) frame = requestAnimationFrame(refresh);
  }

  function syncOverlaySpace() {
    const footer = hud && document.body.classList.contains('controller-input')
      ? Math.ceil(hud.getBoundingClientRect().height) : 0;
    footerSpace = footer ? footer + 6 : 0;
    toolbarSpace = Math.ceil(toolbar.getBoundingClientRect().bottom);
    for (const overlay of document.querySelectorAll('.scrim, .controller-overlay, #cornerAccountDialog, .account-notification-tray, .pause-overlay')) {
      const bottom = footerSpace + 'px';
      if (overlay.style.getPropertyValue('--controller-footer-space') !== bottom) {
        overlay.style.setProperty('--controller-footer-space', bottom);
      }
      if (overlay.id === 'cornerAccountDialog') {
        const top = toolbarSpace + 'px';
        if (overlay.style.getPropertyValue('--toolbar-space') !== top) overlay.style.setProperty('--toolbar-space', top);
      }
    }
  }

  function fitBoard() {
    boardFrame = 0;
    if (!stage?.isConnected) return;
    const scene = stage.querySelector('#scene');
    if (!scene) return;
    // Pixel dimensions also support console Edge versions without cqh.
    // Measure only on resize, never in the camera/controller frame loops.
    const width = Math.max(1, Math.floor(Math.min(stage.clientWidth, stage.clientHeight / .76)));
    const height = Math.max(1, Math.floor(width * .76));
    if (scene.style.width === width + 'px' && scene.style.height === height + 'px') return;
    scene.style.width = width + 'px';
    scene.style.height = height + 'px';
    if (legacyUnits) {
      stage.style.setProperty('--container-unit-width', stage.clientWidth / 100 + 'px');
      stage.style.setProperty('--container-unit-height', stage.clientHeight / 100 + 'px');
      const plane = stage.querySelector('#plane');
      if (plane) {
        plane.style.height = plane.clientWidth + 'px';
        plane.style.setProperty('--container-unit-width', plane.clientWidth / 100 + 'px');
      }
    }
    if (typeof game !== 'undefined' && game) {
      if (typeof busy !== 'undefined' && !busy) {
        if (typeof ui !== 'undefined' && ui.manage) cameraFocus(manageSquare(), 0, 'close');
        else cameraReset(0);
      }
      if (typeof fitCellNames === 'function') fitCellNames();
    }
  }

  function queueBoardFit() {
    if (!boardFrame) boardFrame = requestAnimationFrame(fitBoard);
  }

  const stageObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(queueBoardFit) : null;
  const chromeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(queueRefresh) : null;
  const modalObserver = new MutationObserver(queueRefresh);
  chromeObserver?.observe(toolbar);

  function refresh() {
    frame = 0;
    const playing = !!app.querySelector('.layout #board');
    document.body.classList.toggle('game-active', playing);
    const cramped = playing && app.clientHeight < (innerWidth < 600 ? 440 : 220);
    document.body.classList.toggle('compact-game', cramped);
    const volume = app.querySelector('.corner-tl');
    const match = app.querySelector('.corner-tr');
    const social = document.querySelector('.account-corner-buttons');
    if (volume) {
      toolbar.querySelector('.corner-tl')?.remove();
      toolbar.prepend(volume);
    }
    if (match) {
      toolbar.querySelector('.corner-tr')?.remove();
      toolbar.appendChild(match);
    } else if (!playing) toolbar.querySelector('.corner-tr')?.remove();
    if (social && social.parentElement !== toolbar) toolbar.appendChild(social);

    const nextStage = app.querySelector('.scene-wrap');
    if (stage !== nextStage) {
      stageObserver?.disconnect();
      stage = nextStage;
      if (stage) stageObserver?.observe(stage);
      queueBoardFit();
    }
    const nextModal = app.querySelector('#modal');
    if (modal !== nextModal) {
      modalObserver.disconnect();
      modal = nextModal;
      if (modal) modalObserver.observe(modal, { childList: true });
    }
    const nextHud = document.getElementById('controllerHud');
    if (hud !== nextHud) {
      if (hud) chromeObserver?.unobserve(hud);
      hud = nextHud;
      if (hud) chromeObserver?.observe(hud);
    }
    syncOverlaySpace();
  }

  new MutationObserver(queueRefresh).observe(app, { childList: true });
  new MutationObserver(queueRefresh).observe(document.body, { childList: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', () => { queueRefresh(); queueBoardFit(); }, { passive: true });
  window.visualViewport?.addEventListener('resize', queueRefresh, { passive: true });
  refresh();
})();
