{
  "name": "{{PACKAGE_NAME}}",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "typecheck": "tsc --noEmit",
    "build": "tsc",
    "start": "node dist/src/index.js"
  },
  "dependencies": { "express": "^5.1.0" },
  "devDependencies": { "@types/express": "^5.0.3", "@types/node": "^22.15.0", "tsx": "^4.19.2", "typescript": "^5.9.2" }
}
