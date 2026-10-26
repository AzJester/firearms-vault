(function startCollectionFeatures() {
  'use strict';
  VaultItemDetails.init();
  VaultEquipment.init();
  VaultRange.init();
  VaultCollectionTools.init();
  // Native listeners keep the new actions compatible with the strict CSP.
  document.querySelectorAll('#toolsMenu .menu-panel, .bottom-more-panel').forEach(menu => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'menu-item';
    button.textContent = 'Log range session'; button.dataset.rangeOpen = ''; menu.prepend(button);
  });
  const maintenance = document.getElementById('mType');
  if (maintenance && !Array.from(maintenance.options).some(option => option.value === 'Maintenance')) maintenance.add(new Option('Maintenance', 'Maintenance'));
  render();
})();
