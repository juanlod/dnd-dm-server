# D&D DM — Angular 20 + NG-ZORRO + Node/Socket.IO

Monorepo con **frontend Angular 20** y **backend Node.js** listo para jugar a D&D con un **DM IA**.

## 🚀 Puesta en marcha

### 1) Backend
```bash
cd server
cp .env.example .env   # edita y pon tu OPENAI_API_KEY
npm i
npm run dev            # http://localhost:3000
```

### 2) Frontend
En otra terminal:
```bash
cd client
npm i
npm start              # http://localhost:4200
```

### 3) Probar
- Abre dos pestañas en `http://localhost:4200`.
- Entra con **el mismo ID de campaña** desde ambas (ej: `bosque-01`).
- Chatea, marca **"Preguntar al DM"** o escribe `@dm` para forzar respuesta.
- Usa el panel de **Tiradas** (`1d20+5`, `2d6+1`, etc.).

## 🔧 Notas
- Cambia la URL del backend en `client/src/app/services/socket.service.ts` si no usas `http://localhost:3000`.
- El historial de la IA se guarda **en memoria** por sala (MVP).
- Si prefieres Angular **sin Zone.js**, te dejo guía breve:
  - `npm uninstall zone.js`
  - En `client/src/app/app.config.ts` añade `provideExperimentalZonelessChangeDetection()`
  - Quita el `import 'zone.js'` de `client/src/main.ts`.
