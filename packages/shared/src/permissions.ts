export const FUNCTIONAL_PERMISSIONS = [
  "chat.use",
  "skill.use",
  "mcp.use",
  "report.create",
  "share.create",
  "export.data",
] as const;

export const SYSTEM_PERMISSIONS = [
  "admin.users",
  "admin.roles",
  "admin.datasources",
  "admin.skills",
  "admin.mcp",
  "admin.settings",
  "admin.audit",
  "admin.ops",
] as const;

export const ALL_PERMISSIONS = [...FUNCTIONAL_PERMISSIONS, ...SYSTEM_PERMISSIONS] as const;

export type FunctionalPermission = (typeof FUNCTIONAL_PERMISSIONS)[number];
export type SystemPermission = (typeof SYSTEM_PERMISSIONS)[number];
export type Permission = (typeof ALL_PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  "chat.use": "使用对话",
  "skill.use": "使用技能",
  "mcp.use": "使用 MCP 工具",
  "report.create": "生成报告",
  "share.create": "创建分享链接",
  "export.data": "导出 CSV / Excel",
  "admin.users": "用户管理",
  "admin.roles": "角色管理",
  "admin.datasources": "数据源管理",
  "admin.skills": "技能管理",
  "admin.mcp": "MCP 管理",
  "admin.settings": "系统设置",
  "admin.audit": "审计日志",
  "admin.ops": "运维",
};

export const PERMISSION_GROUPS = [
  {
    label: "功能权限",
    permissions: FUNCTIONAL_PERMISSIONS.map((permission) => ({
      permission,
      label: PERMISSION_LABELS[permission],
    })),
  },
  {
    label: "系统权限（仅内置管理员）",
    permissions: SYSTEM_PERMISSIONS.map((permission) => ({
      permission,
      label: PERMISSION_LABELS[permission],
    })),
  },
] as const;

const permissionSet = new Set<string>(ALL_PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return permissionSet.has(value);
}

export function isSystemPermission(value: string): value is SystemPermission {
  return (SYSTEM_PERMISSIONS as readonly string[]).includes(value);
}
