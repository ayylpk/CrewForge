<script setup lang="ts">
/* ============================================================
   新建项目弹窗（9/18）
   ------------------------------------------------------------
   为什么从"一整页"改成"一个弹窗"：
     原 `/projects/new` 和「需求对话」页**四个板块完全相同**（名称/描述/确认模式/参考文件），
     只有"已确认功能 + 对话框"是后者独有 —— 两页高度重复（用户实测反馈）。
     创建项目本质是"登记一条记录"，不是"干活的工作台"；工作台是需求对话页。
     所以创建退化成：**只收 名称 + 描述** → 建完去需求对话页澄清功能。

   刻意不放的东西（都不是漏了）：
     · **确认模式**：需求对话页有下拉、选中即保存，那边才是它的家（这里问了就重复）。
       创建时按 schema 默认给 `green`（=0 全绿灯，与 sys_project.confirm_mode 的列默认一致），
       你进需求对话页想改随时改。
     · **参考文件**：原新建页那块只是内存摆件 —— 文件从没上传、也没随创建提交，
       刷新就没了，还占一整个板块。宁可不摆这个假控件。
   ============================================================ */
import { ref } from 'vue'
import AppModal from './AppModal.vue'
import { createProject } from '../../api/project'
import { toast } from '../../utils/toast'

const emit = defineEmits<{ close: []; created: [] }>()

const name = ref('')
const description = ref('')
const submitting = ref(false)

async function submit() {
  const n = name.value.trim()
  const d = description.value.trim()
  if (!n) { toast.warning('请先填写项目名称'); return }
  if (!d) { toast.warning('请先描述这个项目要做什么'); return }

  submitting.value = true
  try {
    await createProject({ name: n, description: d, confirmMode: 'green' })
    toast.success('项目已创建——在台账里点它进「需求对话」确认功能')
    emit('created')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AppModal title="新建项目" sheet="FORM-A02" width="760px" @close="emit('close')">
    <label class="csrow">
      <span class="csrow-k">项目名称</span>
      <input
        v-model="name"
        class="input"
        type="text"
        placeholder="如：CRM 客户管理系统"
        @keydown.enter.prevent="submit"
      />
    </label>

    <label class="csrow csrow-col">
      <span class="csrow-k">项目描述</span>
      <textarea
        v-model="description"
        class="textarea"
        rows="11"
        placeholder="描述这个项目要做什么样子的项目，如：为企业做一个 CRM 客户管理系统，管理客户档案、跟进销售过程、生成统计报表"
      ></textarea>
      <span class="cs-hint faint">
        创建后进「需求对话」页，项目经理会据此和你逐条确认功能清单 —— 功能不在这个弹窗里填。
      </span>
    </label>

    <template #footer>
      <button class="btn" :disabled="submitting" @click="emit('close')">取消</button>
      <button class="btn btn-primary" :disabled="submitting" @click="submit">
        {{ submitting ? '创建中…' : '创建项目' }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.csrow {
  display: grid;
  grid-template-columns: 72px 1fr;
  align-items: center;
  gap: 8px 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}
.csrow:last-of-type {
  border-bottom: none;
}
/* 描述那一行是上下结构：标题栏在左、正文占满，标签与输入框别挤成一排 */
.csrow-col {
  grid-template-columns: 72px 1fr;
  align-items: start;
}
.csrow-k {
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--ink-2);
  padding-top: 6px;
}
.cs-hint {
  grid-column: 2;
  font-size: 11px;
  line-height: 1.6;
}
</style>
