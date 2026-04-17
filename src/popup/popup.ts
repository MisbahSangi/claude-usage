const enabledCheckbox = document.querySelector<HTMLInputElement>('#enabled');
const saveButton = document.querySelector<HTMLButtonElement>('#save');
const statusText = document.querySelector<HTMLParagraphElement>('#status');

if (!enabledCheckbox || !saveButton || !statusText) {
  throw new Error('Popup UI elements are missing.');
}

const enabledCheckboxEl = enabledCheckbox;
const saveButtonEl = saveButton;
const statusTextEl = statusText;

function setStatus(message: string): void {
  statusTextEl.textContent = message;
}

function loadSettings(): void {
  chrome.storage.local.get('cupEnabled', (result) => {
    const rawValue = result.cupEnabled;
    enabledCheckboxEl.checked = typeof rawValue === 'boolean' ? rawValue : true;
  });
}

function saveSettings(): void {
  const cupEnabled = enabledCheckboxEl.checked;
  chrome.storage.local.set({ cupEnabled }, () => {
    setStatus('Saved');
    window.setTimeout(() => setStatus(''), 1200);
  });
}

saveButtonEl.addEventListener('click', saveSettings);
loadSettings();
