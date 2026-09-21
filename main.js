const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const sevenBin = require('7zip-bin');
const { execFile } = require('child_process');
const crypto = require('crypto');

let mainWindow;

// CONFIGURACIÓN DEL SERVIDOR Y RELEASE DE GITHUB
const VPS_IP = "38.242.128.51";
const VPS_PORT = 7777;

// CONFIGURACIÓN DE DISCORD OAuth2 (cliente público con PKCE)
const DISCORD_CLIENT_ID = '1551652895915515984';
const DISCORD_REDIRECT_URI = 'http://127.0.0.1/callback';
const DISCORD_SCOPE = 'identify';
const discordAuthPath = path.join(app.getPath('userData'), 'discord-auth.json');
const discordTestCharactersPath = path.join(__dirname, 'discord-test-characters.json');
let discordLoginInProgress = false;

// URL directa al archivo .7z subido en GitHub Releases
const CLIENT_ZIP_URL = "https://github.com/guille1914/skyrim-rp-client/releases/download/v1.0.0/skse64_2_03_01.7z";

function hasSkyMpClient(skyrimPath) {
  const sksePluginsFolder = path.join(skyrimPath, 'Data', 'SKSE', 'Plugins');
  const requiredPlugins = ['MpClientPlugin.dll', 'SkyrimPlatform.dll'];

  return requiredPlugins.every((fileName) => fs.existsSync(path.join(sksePluginsFolder, fileName)));
}

function createPkceValues() {
  // El verifier solo se conserva en memoria durante este login.
  // Discord recibirá únicamente el challenge y después comprobará que ambos coinciden.
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return { codeVerifier, codeChallenge };
}

function waitForDiscordCallback(expectedState) {
  return new Promise((resolve, reject) => {
    let settled = false;

    // Discord redirige el navegador a este servidor local después de autorizar.
    // El servidor se cierra en cuanto recibe una respuesta válida o un error.
    const callbackServer = http.createServer((request, response) => {
      const requestUrl = new URL(request.url, DISCORD_REDIRECT_URI);

      if (requestUrl.pathname !== '/callback') {
        response.writeHead(404);
        response.end('Not found');
        return;
      }

      const error = requestUrl.searchParams.get('error');
      const receivedState = requestUrl.searchParams.get('state');
      const code = requestUrl.searchParams.get('code');

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Discord</title><p>Ya puedes volver al launcher.</p>');

      if (error) {
        finish(new Error(`Discord rechazó la autenticación: ${error}`));
        return;
      }

      // El state demuestra que la respuesta pertenece al login que acabamos de iniciar.
      // Si no coincide, se descarta la respuesta y nunca se usa su código.
      if (!receivedState || receivedState !== expectedState) {
        finish(new Error('La respuesta de Discord no coincide con la solicitud de inicio de sesión.'));
        return;
      }

      if (!code) {
        finish(new Error('Discord no devolvió un código de autorización.'));
        return;
      }

      finish(null, code);
    });

    // Evita dejar un servidor local abierto si el usuario cierra el navegador.
    const timeout = setTimeout(() => {
      finish(new Error('El inicio de sesión de Discord ha caducado.'));
    }, 5 * 60 * 1000);

    function finish(error, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callbackServer.close();
      if (error) reject(error);
      else resolve(code);
    }

    callbackServer.once('error', (error) => {
      finish(new Error(`No se pudo abrir el callback local en el puerto 80: ${error.message}`));
    });

    callbackServer.listen(80, '127.0.0.1');
  });
}

async function fetchDiscordUser(accessToken, tokenType = 'Bearer') {
  // El token permite consultar la identidad básica porque el scope solicitado es "identify".
  const response = await axios.get('https://discord.com/api/users/@me', {
    headers: { Authorization: `${tokenType} ${accessToken}` }
  });

  return {
    id: response.data.id,
    username: response.data.username,
    globalName: response.data.global_name || null
  };
}

function addTestCharacterToUser(user) {
  // Relación temporal para pruebas: Discord puede tener un username técnico
  // distinto del nombre visible (globalName), por eso se comprueban ambos.
  // No se guarda el token ni se usa el token como identificador del personaje.
  try {
    const characterData = fs.readJsonSync(discordTestCharactersPath);
    const matchingUser = Object.entries(characterData.users || {}).find(
      ([username]) => [user.username, user.globalName]
        .filter(Boolean)
        .some((discordName) => username.toLowerCase() === discordName.toLowerCase())
    );

    return {
      ...user,
      character: matchingUser ? matchingUser[1].character : null
    };
  } catch (error) {
    console.error('No se pudo leer discord-test-characters.json:', error.message);
    return { ...user, character: null };
  }
}

function readDiscordAuth() {
  try {
    if (fs.existsSync(discordAuthPath)) {
      return fs.readJsonSync(discordAuthPath);
    }
  } catch (error) {
    console.error('No se pudo leer la sesión de Discord:', error.message);
  }

  return null;
}

async function getStoredDiscordUser() {
  const storedAuth = readDiscordAuth();
  if (!storedAuth || !storedAuth.accessToken) return null;

  try {
    // Se valida el token al arrancar consultando de nuevo a Discord.
    // Así no mostramos como conectado a un usuario cuya sesión ya caducó.
    const user = addTestCharacterToUser(
      await fetchDiscordUser(storedAuth.accessToken, storedAuth.tokenType)
    );
    await fs.writeJson(discordAuthPath, { ...storedAuth, user }, { spaces: 2 });
    return user;
  } catch (error) {
    await fs.remove(discordAuthPath);
    return null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 580,
    resizable: false,
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- CONTROLES DE LA VENTANA ---
ipcMain.on('close-app', () => app.quit());
ipcMain.on('minimize-app', () => mainWindow.minimize());

// --- SELECTOR DE CARPETA DE SKYRIM ---
ipcMain.handle('select-skyrim-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Selecciona la carpeta principal de Skyrim Special Edition'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('get-discord-user', async () => getStoredDiscordUser());

ipcMain.handle('logout-discord', async () => {
  try {
    // La desconexión local elimina el token guardado en este ordenador.
    // No revoca la autorización de Discord, por lo que el usuario podrá volver a entrar.
    await fs.remove(discordAuthPath);
    return { success: true };
  } catch (error) {
    console.error('No se pudo cerrar la sesión de Discord:', error.message);
    return { success: false, message: 'No se pudo cerrar la sesión de Discord.' };
  }
});

ipcMain.handle('login-discord', async () => {
  if (discordLoginInProgress) {
    return { success: false, message: 'Ya hay un inicio de sesión de Discord en curso.' };
  }

  discordLoginInProgress = true;

  try {
    // Cada login usa valores nuevos. El state protege la redirección y el PKCE
    // evita que un código interceptado pueda canjearse sin el verifier original.
    const state = crypto.randomBytes(32).toString('hex');
    const { codeVerifier, codeChallenge } = createPkceValues();
    const callbackPromise = waitForDiscordCallback(state);
    const authorizeUrl = new URL('https://discord.com/oauth2/authorize');

    // Esta URL se abre en el navegador predeterminado, no dentro de Electron.
    authorizeUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: DISCORD_CLIENT_ID,
      scope: DISCORD_SCOPE,
      redirect_uri: DISCORD_REDIRECT_URI,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    }).toString();

    await shell.openExternal(authorizeUrl.toString());
  // La promesa queda esperando hasta que Discord redirige a localhost.
    const authorizationCode = await callbackPromise;

  // El código es de un solo uso. Se canjea junto al mismo redirect URI y verifier.
  // Al ser una aplicación pública, no se envía ningún client_secret.
    const tokenResponse = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        grant_type: 'authorization_code',
        code: authorizationCode,
        redirect_uri: DISCORD_REDIRECT_URI,
        code_verifier: codeVerifier
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const tokenData = tokenResponse.data;
    const user = addTestCharacterToUser(
      await fetchDiscordUser(tokenData.access_token, tokenData.token_type)
    );

  // Se guarda la sesión en la carpeta de datos de Electron, fuera de Skyrim.
  // En el siguiente arranque se volverá a validar con Discord.
    await fs.writeJson(discordAuthPath, {
      accessToken: tokenData.access_token,
      tokenType: tokenData.token_type || 'Bearer',
      refreshToken: tokenData.refresh_token || null,
      expiresIn: tokenData.expires_in || null,
      user
    }, { spaces: 2 });

    return { success: true, user };
  } catch (error) {
    console.error('Error durante el inicio de sesión con Discord:', error);
    return {
      success: false,
      message: error.response?.data?.error_description || error.message || 'No se pudo iniciar sesión con Discord.'
    };
  } finally {
    discordLoginInProgress = false;
  }
});

// --- GESTIÓN DE profileId ÚNICO Y PERSISTENTE POR INSTALACIÓN ---
// Se guarda FUERA de la carpeta de Skyrim (en la carpeta de datos de la app),
// así sobrevive a reinstalaciones del juego o borrados de Data\Platform.
// Se genera una sola vez por PC/instalación del launcher y se reutiliza siempre.
const launcherConfigPath = path.join(app.getPath('userData'), 'launcher-profile.json');

function getOrCreateProfileId() {
  try {
    if (fs.existsSync(launcherConfigPath)) {
      const existing = fs.readJsonSync(launcherConfigPath);
      if (existing && Number.isInteger(existing.profileId)) {
        return existing.profileId;
      }
    }
  } catch (e) {
    // Si el archivo está corrupto o no se puede leer, simplemente generamos uno nuevo
    console.error('No se pudo leer launcher-profile.json, generando uno nuevo:', e.message);
  }

  // Número aleatorio criptográficamente seguro entre 1000 y ~2.147.483.647
  // Con este rango, la probabilidad de colisión entre cientos de instalaciones es insignificante.
  const newId = crypto.randomInt(1000, 2147483647);

  try {
    fs.ensureFileSync(launcherConfigPath);
    fs.writeJsonSync(launcherConfigPath, { profileId: newId });
  } catch (e) {
    console.error('No se pudo guardar launcher-profile.json:', e.message);
    // Aunque falle el guardado, devolvemos el id igualmente para no bloquear el arranque;
    // en el peor caso, se generará uno nuevo en el próximo arranque.
  }

  return newId;
}

// --- FUNCIÓN DE DESCARGA Y EXTRACCIÓN DE .7Z ---
async function downloadClientFiles(skyrimPath, event) {
  const temp7zPath = path.join(app.getPath('temp'), 'client_files_temp.7z');

  try {
    event.sender.send('status-update', 'Conectando con GitHub...');

    const response = await axios({
      method: 'get',
      url: CLIENT_ZIP_URL,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      onDownloadProgress: (progressEvent) => {
        if (progressEvent.total) {
          const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          event.sender.send('status-update', `Descargando componentes: ${percent}%`);
        } else {
          event.sender.send('status-update', 'Descargando componentes...');
        }
      }
    });

    event.sender.send('status-update', 'Guardando archivo descargado...');
    await fs.writeFile(temp7zPath, response.data);

    event.sender.send('status-update', 'Instalando componentes en Skyrim...');

    await new Promise((resolve, reject) => {
      execFile(sevenBin.path7za, ['x', temp7zPath, `-o${skyrimPath}`, '-aoa'], { windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || stdout || error.message).trim()));
          return;
        }
        resolve();
      });
    });

    // Si el contenido se extrajo en una subcarpeta, mover todo a la raíz.
    const subfolderPath = path.join(skyrimPath, 'skse64_2_03_01');
    if (await fs.pathExists(subfolderPath)) {
      await fs.copy(subfolderPath, skyrimPath, { overwrite: true });
      await fs.remove(subfolderPath);
    }

    await fs.remove(temp7zPath);
    return true;
  } catch (error) {
    console.error('Error durante la descarga o extracción:', error);
    event.sender.send('status-update', 'Error al descargar componentes: ' + error.message);
    return false;
  }
}

// --- LANZADOR DEL JUEGO (ÚNICO Y CORRECTO) ---
ipcMain.handle('launch-game', async (event, skyrimPath) => {
  if (!skyrimPath || !fs.existsSync(skyrimPath)) {
    return { success: false, message: 'La ruta de Skyrim no es válida.' };
  }

  const skseExecutable = path.join(skyrimPath, 'skse64_loader.exe');
  const pluginsFolder = path.join(skyrimPath, 'Data', 'Platform', 'Plugins');
  const skympConfigPath = path.join(pluginsFolder, 'skymp5-client-settings.txt');

  // 1. Descargar SkyMP si falta el cliente; SKSE por sí solo no es suficiente.
  if (!fs.existsSync(skseExecutable) || !hasSkyMpClient(skyrimPath)) {
    // Preferir copia desde la carpeta local `skse64_2_02_06` si está incluida con el launcher
    const localSkseSource = path.join(__dirname, '..', 'skse64_2_02_06');
    if (!fs.existsSync(skseExecutable) && fs.existsSync(localSkseSource)) {
      try {
        event.sender.send('status-update', 'Copiando archivos de SKSE desde la carpeta local...');
        await fs.copy(localSkseSource, skyrimPath, { overwrite: true });
      } catch (err) {
        console.error('Error al copiar SKSE desde local:', err);
        return { success: false, message: 'Error al copiar archivos locales de SKSE: ' + err.message };
      }
    } else {
      const installed = await downloadClientFiles(skyrimPath, event);
      if (!installed) {
        return { success: false, message: 'No se pudieron descargar ni extraer los archivos requeridos. Revisa que Skyrim no esté abierto y que tengas permisos de escritura.' };
      }
    }

    if (!hasSkyMpClient(skyrimPath)) {
      return { success: false, message: 'El paquete instalado no contiene los plugins de SkyMP en Data\\SKSE\\Plugins.' };
    }
  }

  // 2. Crear o actualizar la configuración de red con profileId único y persistente
  try {
    if (!fs.existsSync(pluginsFolder)) {
      await fs.ensureDir(pluginsFolder);
    }

    const myProfileId = getOrCreateProfileId();

    const configData = {
      "gameData": {
        "profileId": myProfileId
      },
      "master": "",
      "server-ip": VPS_IP,
      "server-master-key": null,
      "server-port": VPS_PORT
    };
    await fs.writeJson(skympConfigPath, configData, { spaces: 2 });
  } catch (err) {
    return { success: false, message: 'Error al escribir la configuración de skymp5: ' + err.message };
  }

  // 3. Ejecutar SKSE64
  event.sender.send('status-update', 'Iniciando Skyrim RP...');

  execFile(skseExecutable, [], { cwd: skyrimPath }, (error) => {
    if (error) {
      console.error('Error al iniciar SKSE:', error);
    }
  });

  setTimeout(() => app.quit(), 4000);
  return { success: true };
});

// --- FLUJO: EJECUTAR PATCHER, VERIFICAR VERSIÓN Y COPIAR SKSE64_2_02_06 ---
async function getExecutableFileVersion(exePath) {
  return new Promise((resolve) => {
    // Usamos PowerShell para obtener FileVersion en Windows
    const psCommand = `(Get-Item \"${exePath}\").VersionInfo.FileVersion`;
    execFile('powershell', ['-NoProfile', '-Command', psCommand], (error, stdout, stderr) => {
      if (error) {
        return resolve(null);
      }
      const ver = String(stdout || '').trim();
      resolve(ver || null);
    });
  });
}

ipcMain.handle('apply-downgrade-and-copy', async (event, skyrimPath) => {
  if (!skyrimPath || !fs.existsSync(skyrimPath)) {
    return { success: false, message: 'La ruta de Skyrim no es válida.' };
  }

  // Pedir al usuario que seleccione el patcher.exe dentro de la carpeta de Skyrim
  const picker = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecciona el ejecutable del patcher (downgrade)',
    defaultPath: skyrimPath,
    properties: ['openFile'],
    filters: [{ name: 'Ejecutables', extensions: ['exe'] }]
  });

  if (picker.canceled || !picker.filePaths || picker.filePaths.length === 0) {
    return { success: false, message: 'Selección de patcher cancelada.' };
  }

  const patcherExe = picker.filePaths[0];

  try {
    event.sender.send('status-update', 'Ejecutando patcher...');
    // Ejecutar el patcher en la carpeta del juego y esperar a que termine
    await new Promise((resolve, reject) => {
      execFile(patcherExe, [], { cwd: skyrimPath }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  } catch (err) {
    console.error('Error al ejecutar patcher:', err);
    return { success: false, message: 'Error al ejecutar el patcher: ' + err.message };
  }

  // Verificar la versión de SkyrimSE.exe
  const skyrimExePath = path.join(skyrimPath, 'SkyrimSE.exe');
  if (!fs.existsSync(skyrimExePath)) {
    return { success: false, message: 'No se encontró SkyrimSE.exe en la carpeta seleccionada.' };
  }

  event.sender.send('status-update', 'Comprobando versión de SkyrimSE.exe...');
  const fileVersion = await getExecutableFileVersion(skyrimExePath);
  if (!fileVersion) {
    return { success: false, message: 'No se pudo leer la versión de SkyrimSE.exe.' };
  }

  // Saber si el downgrade se ha hecho (versión 1.6.x)
  if (!fileVersion.startsWith('1.6')) {
    return { success: false, message: `La versión detectada es ${fileVersion}. Se esperaba 1.6.x después del downgrade.` };
  }

  // Copiar contenido de skse64_2_02_06 al directorio del juego
  const sourceSkse = path.join(__dirname, '..', 'skse64_2_02_06');
  if (!fs.existsSync(sourceSkse)) {
    return { success: false, message: 'Carpeta local skse64_2_02_06 no encontrada en el launcher.' };
  }

  try {
    event.sender.send('status-update', 'Copiando archivos de SKSE (2.02.06) al juego...');
    await fs.copy(sourceSkse, skyrimPath, { overwrite: true });
  } catch (copyErr) {
    console.error('Error al copiar SKSE:', copyErr);
    return { success: false, message: 'Error al copiar archivos de SKSE: ' + copyErr.message };
  }

  event.sender.send('status-update', 'Downgrade aplicado y archivos copiados.');
  return { success: true, message: 'Downgrade aplicado y archivos copiados correctamente.' };
});