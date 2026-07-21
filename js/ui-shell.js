(function initVaultUI(global) {
  'use strict';

  const SECTION_META = Object.freeze({
    dashboard: {
      eyebrow: 'Collection overview', title: 'Overview',
      description: 'What needs attention, what changed, and the value of your collection.',
      noun: 'summary', addLabel: '', search: false
    },
    all: {
      eyebrow: 'Private collection', title: 'Firearms',
      description: 'Active firearms in your collection.',
      noun: 'firearm', addLabel: 'Add firearm', placeholder: 'Search make, model, serial, caliber, or tag…', filters: true
    },
    nfa: {
      eyebrow: 'Regulated items', title: 'NFA items',
      description: 'Tax-stamp status, submission dates, and regulated items.',
      noun: 'NFA item', addLabel: 'Add NFA item', placeholder: 'Search NFA items…', filters: true
    },
    disposed: {
      eyebrow: 'Collection history', title: 'Sold / transferred',
      description: 'Firearms that have left your active collection.',
      noun: 'record', addLabel: '', placeholder: 'Search sold or transferred firearms…', filters: true
    },
    ammo: {
      eyebrow: 'Inventory', title: 'Ammunition',
      description: 'Rounds on hand, cost, caliber, and low-stock alerts.',
      noun: 'ammunition item', addLabel: 'Add ammunition', placeholder: 'Search caliber, brand, load, or location…'
    },
    accessories: {
      eyebrow: 'Inventory', title: 'Accessories',
      description: 'Optics, suppressors, parts, cases, and other equipment.',
      noun: 'accessory', addLabel: 'Add accessory', placeholder: 'Search accessories…'
    },
    wishlist: {
      eyebrow: 'Planning', title: 'Wishlist',
      description: 'Priorities, target prices, and future additions.',
      noun: 'wishlist item', addLabel: 'Add wishlist item', placeholder: 'Search wishlist…'
    },
    dealers: {
      eyebrow: 'Directory', title: 'FFL dealers',
      description: 'Saved dealers, transfer contacts, and license details.',
      noun: 'dealer', addLabel: 'Add dealer', placeholder: 'Search dealer name, FFL number, city, or notes…'
    }
  });

  function collectionCount(section) {
    if (typeof db === 'undefined' || !db) return 0;
    const firearms = Array.isArray(db.firearms) ? db.firearms : [];
    if (section === 'all') return firearms.filter(item => !item.status || item.status === 'Active').length;
    if (section === 'nfa') return firearms.filter(item => (!item.status || item.status === 'Active') && item.isNFA).length;
    if (section === 'disposed') return firearms.filter(item => item.status && item.status !== 'Active').length;
    if (section === 'ammo') return Array.isArray(db.ammo) ? db.ammo.length : 0;
    if (section === 'accessories') return Array.isArray(db.accessories) ? db.accessories.length : 0;
    if (section === 'wishlist') return Array.isArray(db.wishlist) ? db.wishlist.length : 0;
    if (section === 'dealers') return Array.isArray(db.dealers) ? db.dealers.length : 0;
    return firearms.length;
  }

  function pluralize(count, noun) {
    if (noun === 'summary') return 'Collection summary';
    if (count === 1) return '1 ' + noun;
    if (noun === 'wishlist item') return count + ' wishlist items';
    if (noun === 'ammunition item') return count + ' ammunition items';
    if (noun === 'NFA item') return count + ' NFA items';
    return count + ' ' + noun + 's';
  }

  function setVisible(element, visible, display) {
    if (!element) return;
    element.hidden = !visible;
    element.style.display = visible ? (display || '') : 'none';
  }

  function updateContext(section, options) {
    const name = SECTION_META[section] ? section : 'all';
    const meta = SECTION_META[name];
    const opts = options || {};
    const appRoot = document.getElementById('appRoot');
    if (appRoot) appRoot.dataset.section = name;

    const eyebrow = document.querySelector('.page-eyebrow');
    const title = document.getElementById('pageTitle');
    const description = document.getElementById('pageDescription');
    const count = Number.isFinite(opts.count) ? opts.count : collectionCount(name);
    if (eyebrow) eyebrow.textContent = meta.eyebrow;
    if (title) title.textContent = meta.title;
    if (description) description.textContent = meta.description;
    const countEl = document.getElementById('pageRecordCount');
    if (countEl) countEl.textContent = pluralize(count, meta.noun);

    const pageAdd = document.getElementById('pageAddBtn');
    if (pageAdd) {
      pageAdd.textContent = meta.addLabel || '';
      setVisible(pageAdd, !!meta.addLabel);
    }

    const toolbar = document.getElementById('mainToolbar');
    if (toolbar) toolbar.dataset.context = name;
    const search = document.getElementById('searchBox');
    if (search) {
      search.placeholder = meta.placeholder || 'Search this section…';
      search.setAttribute('aria-label', meta.placeholder || 'Search this section');
      setVisible(search, meta.search !== false);
    }
    const filterButton = document.getElementById('filterBtn');
    const firearmFilters = ['filterType', 'filterCaliber', 'filterTag', 'filterCondition'];
    setVisible(filterButton, !!meta.filters);
    firearmFilters.forEach(id => {
      const control = document.getElementById(id);
      if (control) control.style.display = meta.filters ? '' : 'none';
    });
    const viewToggle = document.querySelector('.view-toggle');
    setVisible(viewToggle, ['all', 'nfa', 'disposed'].includes(name), 'flex');
  }

  function settingsPanelHeading(title, description) {
    const header = document.createElement('header');
    header.className = 'settings-panel-heading';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const copy = document.createElement('p');
    copy.textContent = description;
    header.append(heading, copy);
    return header;
  }

  function settingsQuickCard(title, copy, actions) {
    const card = document.createElement('div');
    card.className = 'settings-card';
    const heading = document.createElement('h4');
    heading.textContent = title;
    const text = document.createElement('p');
    text.className = 'settings-help';
    text.textContent = copy;
    const actionRow = document.createElement('div');
    actionRow.className = 'mfa-actions';
    actions.forEach(action => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = action.className || 'btn btn-outline';
      button.textContent = action.label;
      button.addEventListener('click', action.run);
      actionRow.appendChild(button);
    });
    card.append(heading, text, actionRow);
    return card;
  }

  async function leaveSettingsFor(openAction) {
    const modal = document.getElementById('settingsModal');
    let closed = true;
    if (modal && typeof global.requestModalClose === 'function') {
      closed = await global.requestModalClose(modal);
    } else if (typeof global.closeSettingsModal === 'function') {
      global.closeSettingsModal();
    }
    if (closed && typeof openAction === 'function') openAction();
  }

  function prepareSettings() {
    const modal = document.getElementById('settingsModal');
    if (!modal || modal.dataset.organized === 'true') return;
    const body = modal.querySelector('.modal-body');
    const sourceGrid = body && body.querySelector(':scope > .form-grid');
    if (!body || !sourceGrid) return;

    const definitions = [
      ['account', 'Account & security', 'Password, sign-in protection, and this trusted device.'],
      ['preferences', 'Preferences', 'Privacy and display choices for this device.'],
      ['data', 'Data & recovery', 'Durability, encryption, backups, cleanup, and diagnostics.'],
      ['sharing', 'Sharing', 'Create and manage deliberate read-only snapshots.'],
      ['activity', 'Activity', 'Review important changes made to this collection.']
    ];
    const shell = document.createElement('div');
    shell.className = 'settings-shell';
    const nav = document.createElement('nav');
    nav.className = 'settings-nav';
    nav.setAttribute('aria-label', 'Settings categories');
    nav.setAttribute('role', 'tablist');
    const content = document.createElement('div');
    content.className = 'settings-content';
    const panels = {};

    definitions.forEach(([key, title, description], index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.settingsSection = key;
      button.textContent = title;
      button.classList.toggle('active', index === 0);
      button.setAttribute('role', 'tab');
      button.id = 'settings-tab-' + key;
      button.setAttribute('aria-controls', 'settings-' + key);
      button.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
      button.tabIndex = index === 0 ? 0 : -1;
      button.addEventListener('click', () => selectSettingsSection(key));
      nav.appendChild(button);

      const panel = document.createElement('section');
      panel.id = 'settings-' + key;
      panel.className = 'settings-panel';
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', button.id);
      panel.hidden = index !== 0;
      panel.appendChild(settingsPanelHeading(title, description));
      const grid = document.createElement('div');
      grid.className = 'form-grid settings-panel-grid';
      panel.appendChild(grid);
      panels[key] = grid;
      content.appendChild(panel);
    });
    nav.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = Array.from(nav.querySelectorAll('[role="tab"]'));
      let index = tabs.indexOf(document.activeElement);
      if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else index = (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
      tabs[index].focus();
      selectSettingsSection(tabs[index].dataset.settingsSection);
    });

    let group = 'account';
    Array.from(sourceGrid.children).forEach(node => {
      const text = (node.textContent || '').toLowerCase();
      if (text.includes('local file encryption')) group = 'data';
      if (node.classList.contains('privacy-setting-row')) group = 'preferences';
      if (node.classList.contains('data-quality-settings') || node.classList.contains('data-safety-panel')) group = 'data';
      if (text.includes('activity log')) group = 'activity';
      panels[group].appendChild(node);
      if (node.classList.contains('privacy-setting-row')) group = 'data';
    });

    const preferenceCard = settingsQuickCard(
      'Appearance',
      'Use the theme button in the header to switch between the light and dark vault themes on this device.',
      [{ label: 'Toggle light / dark theme', run: () => { if (typeof global.toggleTheme === 'function') global.toggleTheme(); } }]
    );
    panels.preferences.prepend(preferenceCard);
    panels.data.prepend(settingsQuickCard(
      'Recovery center',
      'Download a full backup, restore a file, or choose a cloud recovery point from one focused workspace.',
      [{ label: 'Open data & recovery', className: 'btn btn-primary', run: () => leaveSettingsFor(() => { if (typeof global.openBackupModal === 'function') global.openBackupModal(); }) }]
    ));
    panels.sharing.appendChild(settingsQuickCard(
      'Read-only inventory snapshots',
      'Share links exclude serial numbers and photos unless you explicitly include them, and can be revoked at any time.',
      [{ label: 'Manage share links', className: 'btn btn-primary', run: () => leaveSettingsFor(() => { if (typeof global.openShareModal === 'function') global.openShareModal(); }) }]
    ));

    sourceGrid.remove();
    shell.append(nav, content);
    body.appendChild(shell);
    modal.dataset.organized = 'true';
  }

  function selectSettingsSection(name) {
    prepareSettings();
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.querySelectorAll('[data-settings-section]').forEach(button => {
      const active = button.dataset.settingsSection === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
    });
    modal.querySelectorAll('.settings-panel').forEach(panel => {
      panel.hidden = panel.id !== 'settings-' + name;
    });
  }

  function syncModalState() {
    const visibleCommand = document.getElementById('cmdk');
    const visibleLightbox = document.getElementById('lightbox');
    const open = !!document.querySelector('.modal-overlay.open, .detail-overlay.open') ||
      !!(visibleCommand && getComputedStyle(visibleCommand).display !== 'none') ||
      !!(visibleLightbox && getComputedStyle(visibleLightbox).display !== 'none');
    document.body.classList.toggle('modal-active', open);
  }

  function installModalObserver() {
    const observer = new MutationObserver(syncModalState);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
    syncModalState();
  }

  function init() {
    prepareSettings();
    installModalObserver();
    updateContext('all');
  }

  global.VaultUI = Object.freeze({
    updateContext,
    prepareSettings,
    selectSettingsSection,
    syncModalState
  });
  global.selectSettingsSection = selectSettingsSection;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(window);
