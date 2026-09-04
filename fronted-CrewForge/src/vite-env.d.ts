/// <reference types="vite/client" />

// VITE_ 环境变量类型（C10 起配置即类型化，加变量在这登记）
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
