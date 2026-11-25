/**
 * Throttled MutationObserver that batches DOM mutations per animation frame
 * to prevent CPU spikes during high-frequency AI streaming output.
 */
export function createThrottledObserver(translator, getCollector) {
  let observedRoots = new WeakSet();
  const observers = [];
  const pendingNodes = new Set();
  let flushScheduled = false;
  let running = false;

  const scheduleFrame =
    typeof requestAnimationFrame === 'function'
      ? (fn) => requestAnimationFrame(fn)
      : (fn) => setTimeout(fn, 24);

  function flush() {
    flushScheduled = false;
    if (!running || pendingNodes.size === 0) {
      pendingNodes.clear();
      return;
    }

    const batch = [...pendingNodes];
    pendingNodes.clear();
    const collector = getCollector ? getCollector() : null;

    for (let i = 0; i < batch.length; i++) {
      const node = batch[i];
      if (!node) continue;
      // Skip detached nodes
      if (node.isConnected === false) continue;
      translator.translateSubtree(node, collector, observeRoot);
    }
  }

  function enqueue(node) {
    if (!node || !running) return;
    pendingNodes.add(node);
    if (!flushScheduled) {
      flushScheduled = true;
      scheduleFrame(flush);
    }
  }

  function handleMutations(mutations) {
    if (!running || translator.isApplying()) return;

    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (m.type === 'characterData') {
        enqueue(m.target);
      } else if (m.type === 'attributes') {
        enqueue(m.target);
      } else if (m.type === 'childList' && m.addedNodes && m.addedNodes.length > 0) {
        for (let j = 0; j < m.addedNodes.length; j++) {
          enqueue(m.addedNodes[j]);
        }
      }
    }
  }

  function observeRoot(root) {
    if (!root || observedRoots.has(root) || typeof MutationObserver !== 'function') {
      return;
    }
    observedRoots.add(root);
    const mo = new MutationObserver(handleMutations);
    mo.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title', 'aria-label'],
    });
    observers.push(mo);
  }

  function start(root) {
    running = true;
    const collector = getCollector ? getCollector() : null;
    translator.translateSubtree(root, collector, observeRoot);
    observeRoot(root);
  }

  function stop() {
    running = false;
    pendingNodes.clear();
    flushScheduled = false;
    observedRoots = new WeakSet();
    while (observers.length > 0) {
      const mo = observers.pop();
      try {
        mo.disconnect();
      } catch {
        // ignore
      }
    }
  }

  return {
    start,
    stop,
    observeRoot,
    isRunning: () => running,
  };
}
