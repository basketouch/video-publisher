# Especificacion funcional: acceso por credenciales y sala privada de videos

## Objetivo

Separar la aplicacion `Video Publisher` en dos experiencias:

- **Zona Admin**: flujo actual para publicar videos.
- **Sala Privada**: visualizacion de videos en modo solo lectura para un usuario invitado (o el propietario).

La sala privada debe ocultar donde estan alojados los videos y no permitir editar, borrar o publicar.

## Alcance de la version 1

- Login con usuario y contrasena en la propia web.
- Roles `admin` y `viewer`.
- Redireccion por rol tras autenticacion.
- Catalogo de videos para reproduccion en sala privada.
- Reproductor de video embebido en la web.
- Permisos estrictos de solo lectura para `viewer`.

## Fuera de alcance en version 1

- Diseno visual final ("diseno chulo").
- Multiusuario avanzado.
- Panel de gestion de usuarios.
- Analitica avanzada de reproduccion.

## Rutas y navegacion

- `/login`: formulario de acceso.
- `/admin`: vista actual de publicacion (protegida para `admin`).
- `/sala`: biblioteca privada de videos (protegida para `viewer` y opcionalmente `admin`).
- `/sala/video/:id`: vista reproductor.

Comportamiento:

1. Usuario no autenticado que entra a cualquier ruta protegida -> redireccion a `/login`.
2. Usuario `admin` autenticado -> acceso a `/admin` y opcionalmente `/sala`.
3. Usuario `viewer` autenticado -> acceso unicamente a `/sala` y `/sala/video/:id`.

## Roles y permisos

### Rol `admin`

- Puede usar toda la funcionalidad existente de `Video Publisher`.
- Puede entrar en sala privada para verificar reproduccion.

### Rol `viewer`

- Puede listar videos permitidos.
- Puede reproducir videos.
- No puede:
  - conectar/desconectar Drive,
  - publicar,
  - editar metadatos,
  - borrar/mover archivos,
  - ver IDs internos o rutas de almacenamiento.

## Reglas de seguridad

1. El frontend nunca recibe credenciales de Google ni claves sensibles.
2. Toda lectura de videos pasa por backend propio.
3. Validacion de sesion y rol en cada endpoint protegido.
4. La carpeta origen se define en backend con una variable fija (por ejemplo `PRIVATE_VIEWER_DRIVE_FOLDER_ID`).
5. No exponer URLs directas permanentes de Drive en la interfaz.
6. Cookies de sesion seguras (`httpOnly`, `secure`, expiracion controlada).
7. Registro de accesos minimo (usuario, fecha, video reproducido).

## Backend: endpoints funcionales propuestos

### Autenticacion

- `POST /api/auth/login`
  - Entrada: usuario + contrasena.
  - Salida: sesion valida + datos basicos de rol.
- `POST /api/auth/logout`
  - Invalida sesion.
- `GET /api/auth/me`
  - Devuelve estado autenticado y rol actual.

### Sala privada

- `GET /api/private/videos`
  - Lista videos de la carpeta autorizada.
  - Campos sugeridos: `id`, `title`, `thumbnail`, `duration`.
- `GET /api/private/videos/:id/stream`
  - Streaming del archivo para `<video>`.
  - Debe soportar `Range` para permitir seek y reproduccion fluida.

### Restricciones

- Cualquier endpoint `/api/private/*` requiere sesion autenticada y rol `viewer` o `admin`.
- Cualquier endpoint de publicacion requiere rol `admin`.

## Interfaz: version funcional inicial

## 1) Login

- Caja centrada con:
  - Usuario
  - Contrasena
  - Boton Entrar
- Mensaje de error generico si credenciales invalidas.

## 2) Admin

- Se mantiene la vista actual.
- Se anade boton opcional "Ir a sala privada" para pruebas del propietario.

## 3) Sala privada (biblioteca)

- Encabezado simple con titulo y boton "Cerrar sesion".
- Grid/lista de videos.
- Cada tarjeta abre la vista de reproduccion.
- Sin menus de gestion.

## 4) Reproductor

- Video principal con controles nativos.
- Titulo del video.
- Boton "Volver".
- Sin acciones de descarga/edicion.

## Datos y configuracion

### Tabla/entidad de usuarios de app (si no existe completa)

Campos minimos:

- `username` o `email`
- `password_hash`
- `role` (`admin` | `viewer`)
- `active` (bool)

### Variables de entorno sugeridas

- `SESSION_SECRET`
- `PRIVATE_VIEWER_DRIVE_FOLDER_ID`
- Variables ya existentes de acceso backend a Drive/Supabase.

## Plan de implementacion por fases

## Fase 1 - Base de autenticacion y roles

- Crear pantalla `/login`.
- Implementar login/logout/me.
- Middleware de proteccion por sesion y rol.
- Redireccion por rol.

Entregable: acceso controlado y separacion de rutas.

## Fase 2 - Sala privada funcional

- Crear `/sala` y `/sala/video/:id`.
- Implementar listados y stream backend de solo lectura.
- Ocultar completamente elementos de gestion.

Entregable: usuario `viewer` puede entrar y reproducir.

## Fase 3 - Endurecimiento y calidad

- Revisar seguridad de cookies y expiracion.
- Auditoria basica de logs.
- Manejo de errores y estados de carga.
- Pruebas manuales de permisos.

Entregable: experiencia estable y segura.

## Checklist de aceptacion

- [ ] Usuario `viewer` entra con credenciales propias.
- [ ] `viewer` solo puede navegar por `/sala`.
- [ ] `viewer` puede ver y reproducir videos.
- [ ] `viewer` no ve controles de publicar/editar/borrar.
- [ ] No se muestra ubicacion real de alojamiento (Drive/rutas internas).
- [ ] `admin` mantiene flujo actual sin regresiones.
- [ ] Cerrar sesion invalida acceso a rutas protegidas.

## Riesgos y mitigaciones

- **Riesgo**: exposicion accidental de enlaces de Drive en frontend.
  - **Mitigacion**: consumir siempre endpoints backend y filtrar campos.
- **Riesgo**: permisos mal aplicados entre rutas.
  - **Mitigacion**: middleware unico por rol y pruebas por matriz de permisos.
- **Riesgo**: cortes en reproduccion al hacer seek.
  - **Mitigacion**: soporte correcto de cabeceras `Range` en stream.

## Nota para la fase de diseno visual

Cuando la version funcional este estable, se puede iterar sobre UI (branding, tipografia, microinteracciones, layout), manteniendo intacta la separacion de roles y los endpoints de seguridad definidos aqui.
