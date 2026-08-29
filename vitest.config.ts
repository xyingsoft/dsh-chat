import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 与 DSH 生态一致：host 侧与 client 侧的测试用文件名区分
    include: ['packages/**/src/**/*.{host,client}.spec.ts'],
    // 装载测试会真起 HTTP 服务，串行执行避免端口与全局状态相互干扰
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
