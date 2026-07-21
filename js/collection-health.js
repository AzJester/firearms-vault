// Collection Health controller. The analyzer lives in data-quality.js so the
// report remains testable and deterministic; this file only renders and saves.
(function initVaultCollectionHealth(global) {
  'use strict';

  const state = { applying: false, initialized: false, lastReport: null };
  const byId = id => document.getElementById(id);
  const clone = value => typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));

  function database() {
    if (typeof db !== 'undefined' && db && typeof db === 'object') return db;
    return global.db && typeof global.db === 'object' ? global.db : null;
  }

  function mediaOptions() {
    const missingMedia = global.CloudSync && Array.isArray(global.CloudSync.missingMedia)
      ? global.CloudSync.missingMedia
      : [];
    return { missingMedia };
  }

  function announce(message, type, timeout) {
    if (typeof global.toast === 'function') global.toast(message, type, timeout);
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }

  function addMetric(container, value, label, detail) {
    const metric = makeElement('div', 'health-metric');
    metric.append(
      makeElement('strong', 'health-metric-value', value),
      makeElement('span', 'health-metric-label', label)
    );
    if (detail) metric.append(makeElement('small', 'health-metric-detail', detail));
    container.append(metric);
  }

  function renderMetrics(report) {
    const container = byId('healthMetrics');
    if (!container) return;
    container.replaceChildren();
    addMetric(container, report.totals.firearms, 'Firearms', 'records reviewed');
    addMetric(container, report.facets.manufacturers.unique, 'Manufacturers', report.coverage.manufacturer.percent + '% complete');
    addMetric(container, report.facets.calibers.unique, 'Calibers / gauges', report.coverage.caliber.percent + '% complete');
    addMetric(container, report.facets.tags.unique, 'Tags', report.facets.tags.assignments + ' assignments');
    addMetric(container, report.coverage.barrel.percent + '%', 'Barrel details', report.coverage.barrel.complete + ' of ' + report.coverage.barrel.total);
    addMetric(container, report.coverage.photos.percent + '%', 'With photos', report.totals.photoReferences + ' photo references');
    addMetric(container, report.coverage.documents.percent + '%', 'With documents', report.totals.documentReferences + ' document references');
    addMetric(container, report.totals.duplicateGroups, 'Possible duplicates', 'manual review only');
    addMetric(container, report.totals.missingAttachments, 'Unavailable files', report.coverage.attachmentIntegrity.percent + '% attachment integrity');
  }

  function activeFilter() {
    return String(byId('healthFilter')?.value || 'all').trim().toLowerCase();
  }

  function issueMatches(issue, filter) {
    if (!filter || filter === 'all') return true;
    if (filter === 'errors' || filter === 'error') return issue.severity === 'error';
    if (filter === 'warnings' || filter === 'warning' || filter === 'attention') return issue.severity === 'warning';
    if (filter === 'safe-fixes' || filter === 'fixes') return !!issue.fixId;
    return String(issue.category || '').toLowerCase() === filter;
  }

  function reviewIssue(issue) {
    if (issue.mediaKey && typeof global.openSyncCenter === 'function') {
      closeCollectionHealth();
      global.openSyncCenter();
      return;
    }
    if (issue.recordId && typeof global.openEditModal === 'function') {
      closeCollectionHealth();
      global.openEditModal(issue.recordId);
    }
  }

  function renderIssues(report) {
    const container = byId('healthIssues');
    if (!container) return;
    container.replaceChildren();
    const filter = activeFilter();
    const matching = report.issues.filter(issue => issueMatches(issue, filter));
    if (!matching.length) {
      container.append(makeElement('p', 'health-empty', filter === 'all'
        ? 'No collection-health issues were found.'
        : 'No issues match this filter.'));
      return;
    }

    matching.slice(0, 200).forEach(issue => {
      const item = makeElement('article', 'health-issue health-issue-' + issue.severity);
      item.dataset.issueId = issue.id || '';
      const copy = makeElement('div', 'health-issue-copy');
      copy.append(
        makeElement('span', 'health-issue-meta', String(issue.category || 'review') + ' · ' + String(issue.severity || 'info')),
        makeElement('strong', 'health-issue-title', issue.title || 'Review item'),
        makeElement('p', 'health-issue-message', issue.message || '')
      );
      item.append(copy);
      const canReview = (issue.mediaKey && typeof global.openSyncCenter === 'function') ||
        (issue.recordId && typeof global.openEditModal === 'function');
      if (canReview) {
        const review = makeElement('button', 'btn btn-small btn-outline health-review-btn', issue.mediaKey ? 'Sync details' : 'Review record');
        review.type = 'button';
        review.addEventListener('click', () => reviewIssue(issue));
        item.append(review);
      }
      container.append(item);
    });
    if (matching.length > 200) {
      container.append(makeElement('p', 'health-limit-note', 'Showing the first 200 of ' + matching.length + ' issues. Use a filter to narrow the list.'));
    }
  }

  function updateApplyButton(report) {
    const button = byId('healthApplyBtn');
    if (!button) return;
    const count = report ? report.totals.safeFixes : 0;
    button.disabled = state.applying || count === 0;
    button.textContent = state.applying
      ? 'Saving cleanup…'
      : count
        ? 'Apply ' + count + ' safe fix' + (count === 1 ? '' : 'es')
        : 'No safe fixes needed';
  }

  function renderCollectionHealth() {
    const source = database();
    const analyzer = global.VaultDataQuality && global.VaultDataQuality.analyzeCollectionHealth;
    if (!source || typeof analyzer !== 'function') {
      const summary = byId('healthSummary');
      if (summary) summary.textContent = 'Collection Health is unavailable. Reload the page and try again.';
      updateApplyButton(null);
      return null;
    }

    const report = analyzer(source, mediaOptions());
    state.lastReport = report;
    const score = byId('healthScore');
    if (score) {
      score.textContent = report.status === 'empty' ? '—' : report.score + '%';
      score.dataset.status = report.status;
      score.setAttribute('aria-label', report.status === 'empty' ? 'No firearms to score' : 'Collection health score ' + report.score + ' percent');
    }
    const summary = byId('healthSummary');
    if (summary) {
      summary.textContent = report.status === 'empty'
        ? 'Add a firearm to begin measuring collection completeness.'
        : report.totals.errors + ' error' + (report.totals.errors === 1 ? '' : 's') + ', ' +
          report.totals.warnings + ' warning' + (report.totals.warnings === 1 ? '' : 's') + ', and ' +
          report.totals.safeFixes + ' safe formatting fix' + (report.totals.safeFixes === 1 ? '' : 'es') + '.';
    }
    const updated = byId('healthUpdatedAt');
    if (updated) updated.textContent = 'Checked ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    renderMetrics(report);
    renderIssues(report);
    updateApplyButton(report);
    return report;
  }

  function openCollectionHealth() {
    const modal = byId('healthModal');
    if (modal) modal.classList.add('open');
    const report = renderCollectionHealth();
    const close = modal && modal.querySelector('[data-health-close], .modal-close');
    if (close && typeof close.focus === 'function') close.focus();
    return report;
  }

  function closeCollectionHealth() {
    byId('healthModal')?.classList.remove('open');
  }

  async function applyCollectionHealthFixes() {
    if (state.applying) return { ok: false, status: 'busy' };
    const source = database();
    if (!source || !global.VaultDataQuality || typeof global.VaultDataQuality.applySafeFixes !== 'function') {
      announce('Collection cleanup is unavailable. Reload the page and try again.', 'error', 9000);
      return { ok: false, status: 'unavailable' };
    }
    if (typeof global.saveData !== 'function') {
      announce('Cleanup was not started because automatic saving is unavailable.', 'error', 9000);
      return { ok: false, status: 'save-unavailable' };
    }

    const report = global.VaultDataQuality.analyzeCollectionHealth(source, mediaOptions());
    if (!report.totals.safeFixes) {
      renderCollectionHealth();
      announce('No safe cleanup is needed.', 'success');
      return { ok: true, status: 'unchanged', changed: 0 };
    }

    state.applying = true;
    updateApplyButton(report);
    try {
      if (global.VaultDataSafety && global.CloudSync && global.CloudSync.uid && typeof global.VaultDataSafety.createBackup === 'function') {
        await global.VaultDataSafety.createBackup(global.CloudSync.uid, source, 'before-collection-health-cleanup', {
          fixCount: report.totals.safeFixes
        });
      }
      const outcome = global.VaultDataQuality.applySafeFixes(source);
      if (!outcome.changed) {
        renderCollectionHealth();
        announce('No safe cleanup is needed.', 'success');
        return { ok: true, status: 'unchanged', changed: 0 };
      }
      if (typeof global.addAuditEntry === 'function') {
        global.addAuditEntry('edit', 'system', 'Collection Health Cleanup', outcome.changed + ' safe formatting changes');
      }
      const saved = await global.saveData();
      if (typeof global.render === 'function') global.render();
      renderCollectionHealth();
      if (!saved) {
        announce('The cleanup is visible, but it could not be saved safely. Keep this page open and use Save now.', 'error', 10000);
        return { ok: false, status: 'save-failed', changed: outcome.changed };
      }
      announce('Collection cleanup applied and saved automatically.', 'success');
      return { ok: true, status: 'saved', changed: outcome.changed };
    } catch (error) {
      announce('Collection cleanup failed before it could be saved: ' + String(error && error.message || error), 'error', 10000);
      return { ok: false, status: 'error', error: String(error && error.message || error) };
    } finally {
      state.applying = false;
      updateApplyButton(state.lastReport || report);
    }
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    byId('healthApplyBtn')?.addEventListener('click', applyCollectionHealthFixes);
    byId('healthFilter')?.addEventListener('change', renderCollectionHealth);
    document.querySelectorAll('[data-health-close]').forEach(button => button.addEventListener('click', closeCollectionHealth));
    byId('healthModal')?.addEventListener('click', event => {
      if (event.target === byId('healthModal')) closeCollectionHealth();
    });
  }

  global.VaultCollectionHealth = Object.freeze({
    open: openCollectionHealth,
    close: closeCollectionHealth,
    render: renderCollectionHealth,
    applySafeFixes: applyCollectionHealthFixes,
    getReport: () => state.lastReport ? clone(state.lastReport) : null
  });
  global.openCollectionHealth = openCollectionHealth;
  global.closeCollectionHealth = closeCollectionHealth;
  global.renderCollectionHealth = renderCollectionHealth;
  global.applyCollectionHealthFixes = applyCollectionHealthFixes;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(window);
