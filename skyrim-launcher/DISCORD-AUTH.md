# Autenticación de Discord del launcher

Este documento explica exactamente qué hace el código relacionado con Discord en el launcher Electron.

## Resumen

El launcher utiliza OAuth2 de Discord con PKCE para:

- Abrir la autenticación en el navegador predeterminado.
- Recibir la respuesta de Discord en el propio ordenador.
- Comprobar que la respuesta pertenece al inicio de sesión solicitado.
- Intercambiar el código temporal por un token de acceso.
- Consultar el ID y el nombre del usuario.
- Mostrar el usuario conectado en la interfaz.
- Guardar localmente la sesión para reutilizarla al abrir el launcher.
- Permitir desconectar la sesión local.

Actualmente **no** se comprueba:

- Si el usuario pertenece a un servidor de Discord.
- Si tiene un rol concreto.
- Si está invitado a un servidor.
- Si tiene permisos especiales.
- Si está autorizado para jugar en el servidor.

Por tanto, esta implementación verifica únicamente la identidad básica de Discord mediante el scope `identify`.

## Archivos implicados

### `main.js`

Es el proceso principal de Electron. Aquí se ejecuta la parte sensible del OAuth2:

- Generación de valores criptográficos.
- Servidor HTTP local para el callback.
- Apertura del navegador.
- Validación del `state`.
- Intercambio del código por el token.
- Petición de los datos del usuario.
- Guardado y borrado de la sesión.

### `index.html`

Contiene la interfaz visible:

- Botón de inicio de sesión.
- Texto del usuario conectado.
- Botón de desconexión.
- Mensajes de espera y error.

### `renderer.js`

No participa en el flujo actual de Discord. La interfaz principal usa un `<script>` incluido directamente en `index.html`.

## Configuración utilizada

En `main.js` están definidos estos valores:

```js
const DISCORD_CLIENT_ID = '1551652895915515984';
const DISCORD_REDIRECT_URI = 'http://127.0.0.1/callback';
const DISCORD_SCOPE = 'identify';
```

### Client ID

El `Client ID` identifica la aplicación creada en Discord Developer Portal.

Es público y puede estar incluido en el launcher.

### Client Secret

No se utiliza ningún `Client Secret`.

La aplicación está configurada como cliente público y el flujo utiliza PKCE. Por eso no hay secretos de Discord dentro del código.

### Redirect URI

Discord debe tener configurada exactamente esta URL:

```text
http://127.0.0.1/callback
```

El launcher escucha esta ruta en el puerto 80 de la dirección local `127.0.0.1`.

## Flujo completo de inicio de sesión

### 1. El usuario pulsa el botón

En `index.html`, el botón tiene este identificador:

```html
<button id="btn-discord-login">
  Iniciar sesión con Discord
</button>
```

El evento llama al proceso principal de Electron mediante IPC:

```js
ipcRenderer.invoke('login-discord');
```

IPC significa comunicación entre:

- Renderer: la interfaz HTML.
- Main process: `main.js`.

La interfaz no realiza directamente las operaciones sensibles. Se las solicita a `main.js`.

### 2. Se evita iniciar dos logins a la vez

`main.js` utiliza la variable:

```js
let discordLoginInProgress = false;
```

Si ya existe un login en curso, se devuelve un error y no se abre otro servidor local ni otra ventana de autenticación.

### 3. Se genera el `state`

El código genera un valor aleatorio:

```js
const state = crypto.randomBytes(32).toString('hex');
```

El `state` sirve para confirmar que la respuesta recibida pertenece al login que acaba de iniciar el launcher.

El valor se envía a Discord y se conserva en memoria hasta recibir el callback.

Cuando Discord vuelve al launcher, se comparan ambos valores:

```js
if (!receivedState || receivedState !== expectedState) {
  // Se rechaza la respuesta
}
```

Si no coinciden, el código recibido no se acepta.

Esto protege el flujo frente a respuestas OAuth inyectadas o asociadas a otra solicitud.

### 4. Se genera PKCE

La función `createPkceValues()` genera dos valores:

```js
const codeVerifier = crypto.randomBytes(32).toString('base64url');
```

El `code_verifier` es un valor secreto temporal. Solo se conserva en memoria durante ese intento de login.

Después se calcula el challenge:

```js
const codeChallenge = crypto
  .createHash('sha256')
  .update(codeVerifier)
  .digest('base64url');
```

La relación es:

```text
code_challenge = BASE64URL(SHA256(code_verifier))
```

Discord recibe el `code_challenge`, pero no recibe el `code_verifier` durante la autorización inicial.

### 5. Se prepara el callback local

Antes de abrir el navegador, el launcher crea un servidor HTTP local:

```js
http.createServer(...)
```

El servidor escucha en:

```text
127.0.0.1:80
```

Solo se acepta la ruta:

```text
/callback
```

Una petición a otra ruta devuelve `404`.

El servidor tiene un tiempo máximo de espera de cinco minutos. Si el usuario no termina el login durante ese tiempo, la operación falla y el servidor se cierra.

### 6. Se abre Discord en el navegador

El launcher crea una URL parecida a esta:

```text
https://discord.com/oauth2/authorize?
response_type=code
&client_id=1551652895915515984
&scope=identify
&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback
&state=...
&code_challenge=...
&code_challenge_method=S256
```

La URL se abre con:

```js
shell.openExternal(authorizeUrl.toString());
```

El usuario inicia sesión en Discord y autoriza el scope `identify`.

El launcher no recoge la contraseña ni muestra una pantalla propia para introducir credenciales.

### 7. Discord devuelve el resultado

Después de autorizar, Discord redirige el navegador a:

```text
http://127.0.0.1/callback?code=...&state=...
```

El servidor local obtiene estos parámetros:

- `code`: código temporal de autorización.
- `state`: valor que debe coincidir con el generado por el launcher.
- `error`: aparece si el usuario cancela o Discord rechaza la autorización.

El launcher responde al navegador con un mensaje sencillo:

```text
Ya puedes volver al launcher.
```

Después procesa la respuesta.

### 8. Se valida la respuesta

El orden de validación es:

1. Si Discord devuelve `error`, el login falla.
2. Si el `state` no coincide, el login falla.
3. Si no hay `code`, el login falla.
4. Solo si todo es correcto se acepta el código.

El servidor local se cierra después de terminar el procesamiento mediante `callbackServer.close()`.

### 9. Se canjea el código por un token

El código temporal se envía a:

```text
https://discord.com/api/oauth2/token
```

Se envían estos datos:

```js
{
  client_id: DISCORD_CLIENT_ID,
  grant_type: 'authorization_code',
  code: authorizationCode,
  redirect_uri: DISCORD_REDIRECT_URI,
  code_verifier: codeVerifier
}
```

El `code_verifier` demuestra a Discord que quien inició la autorización es el mismo launcher que recibió el código.

El `redirect_uri` debe ser exactamente el mismo que se utilizó al crear la URL de autorización.

No se envía `client_secret`.

El código de autorización es temporal y de un solo uso. Si ya se utilizó o ha caducado, Discord devuelve un error.

### 10. Se consulta el usuario autenticado

Con el `access_token` recibido, el launcher consulta:

```text
https://discord.com/api/users/@me
```

La petición incluye:

```http
Authorization: Bearer ACCESS_TOKEN
```

La función `fetchDiscordUser()` extrae:

```js
{
  id: response.data.id,
  username: response.data.username,
  globalName: response.data.global_name || null
}
```

El resultado contiene como mínimo:

- ID único de Discord.
- Username de Discord.
- Nombre global, si Discord lo proporciona.

El scope `identify` es suficiente para estos datos básicos. No se solicita el email.

### 11. Se guarda la sesión

La sesión se guarda en:

```text
app.getPath('userData')/discord-auth.json
```

El archivo contiene información similar a:

```json
{
  "accessToken": "...",
  "tokenType": "Bearer",
  "refreshToken": "...",
  "expiresIn": 604800,
  "user": {
    "id": "123456789012345678",
    "username": "usuario",
    "globalName": "Usuario"
  }
}
```

La ubicación exacta depende del sistema operativo y del nombre de la aplicación Electron.

El archivo no se guarda dentro de la carpeta de Skyrim.

## Restauración de sesión al abrir el launcher

Al cargar `index.html`, se ejecuta:

```js
ipcRenderer.invoke('get-discord-user')
```

`main.js` realiza estos pasos:

1. Lee `discord-auth.json`.
2. Comprueba que existe un `accessToken`.
3. Consulta de nuevo `https://discord.com/api/users/@me`.
4. Si Discord responde correctamente, devuelve el usuario a la interfaz.
5. Si el token no es válido, elimina `discord-auth.json` y devuelve que no hay sesión.

La interfaz no confía únicamente en los datos guardados. Comprueba otra vez el token con Discord.

## Qué aparece en la interfaz

Si no existe una sesión válida:

```text
Iniciar sesión con Discord
```

Si existe una sesión válida:

```text
Conectado como: NOMBRE_DEL_USUARIO
Desconectar de Discord
```

La interfaz usa `globalName` cuando existe. Si no existe, usa `username`.

## Desconexión

Al pulsar `Desconectar de Discord`, la interfaz llama a:

```js
ipcRenderer.invoke('logout-discord');
```

`main.js` elimina el archivo local:

```js
await fs.remove(discordAuthPath);
```

Después la interfaz vuelve al estado inicial de login.

Esta desconexión:

- Borra el token guardado en este ordenador.
- Borra la sesión local del launcher.
- Permite volver a iniciar sesión.

Esta desconexión no revoca la autorización en la cuenta de Discord. Para revocarla completamente habría que implementar una llamada adicional al endpoint de revocación OAuth2.

## Qué ocurre si algo falla

Los errores se capturan en `main.js` y se devuelven a la interfaz con un objeto de este tipo:

```js
{
  success: false,
  message: 'Descripción del error'
}
```

La interfaz muestra el mensaje y vuelve a activar el botón de login.

Casos contemplados:

- Ya hay otro login en curso.
- El usuario cancela la autorización.
- Discord devuelve un error.
- El `state` no coincide.
- Falta el código de autorización.
- El puerto 80 está ocupado.
- El callback caduca después de cinco minutos.
- Discord rechaza el intercambio del código.
- El token no permite consultar al usuario.
- La sesión guardada deja de ser válida.

## Qué significa exactamente "verificar Discord"

En el estado actual, verificar Discord significa:

1. Recibir una respuesta OAuth válida.
2. Comprobar el `state`.
3. Completar correctamente PKCE.
4. Obtener un `access_token` válido.
5. Usar ese token para consultar `/users/@me`.
6. Obtener el ID y el nombre del usuario.

No significa todavía verificar que el usuario pueda entrar a tu servidor de juego.

Tampoco impide que alguien modifique el launcher, porque todavía no existe una validación contra un backend propio ni una comprobación desde el servidor del juego.

## Requisitos de configuración

En Discord Developer Portal, la aplicación debe tener esta Redirect URI exacta:

```text
http://127.0.0.1/callback
```

El launcher debe poder escuchar el puerto 80 de `127.0.0.1`.

No es necesario configurar un bot, un servidor de Discord, roles ni un Client Secret para este flujo básico.

## Resumen técnico

```text
Botón HTML
  -> ipcRenderer.invoke('login-discord')
  -> generar state
  -> generar code_verifier y code_challenge
  -> iniciar callback local en 127.0.0.1:80
  -> abrir Discord en el navegador
  -> recibir code y state
  -> validar state
  -> canjear code + code_verifier
  -> recibir access_token
  -> consultar /api/users/@me
  -> guardar discord-auth.json
  -> mostrar username
```
