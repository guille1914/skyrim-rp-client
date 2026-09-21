const { ipcRenderer } = require('electron');

// Elementos de la interfaz (asegúrate de que los IDs coincidan con tu HTML)
const btnSelectFolder = document.getElementById('btn-select-folder');
const btnPlay = document.getElementById('btn-play');
const btnClose = document.getElementById('btn-close');
const btnMinimize = document.getElementById('btn-minimize');
const pathInput = document.getElementById('skyrim-path-input');
const statusText = document.getElementById('status-text');

// Escuchar actualizaciones de estado desde main.js
ipcRenderer.on('status-update', (event, message) => {
  if (statusText) statusText.innerText = message;
});

// Botón de cerrar ventana
if (btnClose) {
  btnClose.addEventListener('click', () => {
    ipcRenderer.send('close-app');
  });
}

// Botón de minimizar ventana
if (btnMinimize) {
  btnMinimize.addEventListener('click', () => {
    ipcRenderer.send('minimize-app');
  });
}

// Botón para seleccionar carpeta de Skyrim
if (btnSelectFolder) {
  btnSelectFolder.addEventListener('click', async () => {
    const selectedPath = await ipcRenderer.invoke('select-skyrim-folder');
    if (selectedPath) {
      pathInput.value = selectedPath;
      localStorage.setItem('skyrim_path', selectedPath);
    }
  });
}

// Cargar la ruta guardada previamente (si existe)
document.addEventListener('DOMContentLoaded', () => {
  const savedPath = localStorage.getItem('skyrim_path');
  if (savedPath && pathInput) {
    pathInput.value = savedPath;
  }
});

// Botón de JUGAR
if (btnPlay) {
  btnPlay.addEventListener('click', async () => {
    const skyrimPath = pathInput ? pathInput.value : '';

    if (!skyrimPath) {
      alert('Por favor, selecciona la carpeta de Skyrim primero.');
      return;
    }

    btnPlay.disabled = true;
    if (statusText) statusText.innerText = 'Preparando parche y comprobando versión...';

    // Ejecutar patcher seleccionado por el usuario, verificar versión y copiar SKSE si procede
    const prepResult = await ipcRenderer.invoke('apply-downgrade-and-copy', skyrimPath);
    if (!prepResult.success) {
      alert(prepResult.message);
      btnPlay.disabled = false;
      if (statusText) statusText.innerText = 'Listo para jugar';
      return;
    }

    if (statusText) statusText.innerText = 'Iniciando juego...';
    const result = await ipcRenderer.invoke('launch-game', skyrimPath);

    if (!result.success) {
      alert(result.message);
      btnPlay.disabled = false;
      if (statusText) statusText.innerText = 'Listo para jugar';
    }
  });
}