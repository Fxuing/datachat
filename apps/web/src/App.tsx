import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { fetchMe } from "./lib/api";
import { installUnauthorizedHandler, queryClient, queryKeys } from "./lib/query";
import LoginPage from "./pages/LoginPage";
import { PageSpinner } from "./components/ui/spinner";
import { BrandingProvider } from "./components/BrandingProvider";

const ChatPage = lazy(() => import("./pages/ChatPage"));
const ReportPage = lazy(() => import("./pages/ReportPage"));
const PublicSharePage = lazy(() => import("./pages/PublicSharePage"));
const RolesPage = lazy(() => import("./pages/admin/RolesPage"));
const UsersPage = lazy(() => import("./pages/admin/UsersPage"));
const DepartmentsPage = lazy(() => import("./pages/admin/DepartmentsPage"));
const DatasourceScopePage = lazy(() => import("./pages/admin/DatasourceScopePage"));
const DatasourceSemanticPage = lazy(() => import("./pages/admin/DatasourceSemanticPage"));
const SkillsPage = lazy(() => import("./pages/admin/SkillsPage"));
const McpPage = lazy(() => import("./pages/admin/McpPage"));
const DatasourcesPage = lazy(() => import("./pages/admin/DatasourcesPage"));
const AuditPage = lazy(() => import("./pages/admin/AuditPage"));
const SettingsPage = lazy(() => import("./pages/admin/SettingsPage"));
const OpsPage = lazy(() => import("./pages/admin/OpsPage"));
const ScheduledTasksPage = lazy(() => import("./pages/ScheduledTasksPage"));
const MemoryPage = lazy(() => import("./pages/MemoryPage"));
const DashboardsPage = lazy(() => import("./pages/DashboardsPage"));

function RequireAuth({ children }: { children: ReactNode }) {
  const meQuery = useQuery({
    queryKey: queryKeys.me,
    queryFn: fetchMe,
    retry: false,
    staleTime: 60_000,
  });

  if (meQuery.isPending) {
    return <PageSpinner label="正在验证登录状态…" />;
  }
  if (meQuery.isError) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

/** Admins only; a non-admin session is sent back to chat instead of seeing the page. */
function RequireAdmin({ children }: { children: ReactNode }) {
  const meQuery = useQuery({
    queryKey: queryKeys.me,
    queryFn: fetchMe,
    retry: false,
    staleTime: 60_000,
  });

  if (meQuery.isPending) {
    return <PageSpinner label="正在验证登录状态…" />;
  }
  if (meQuery.isError) {
    return <Navigate to="/login" replace />;
  }
  if (meQuery.data.user.role !== "admin") {
    return <Navigate to="/chat" replace />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  const navigate = useNavigate();

  useEffect(
    () => installUnauthorizedHandler((path) => navigate(path, { replace: true })),
    [navigate],
  );

  return (
    <Suspense fallback={<PageSpinner />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/s/:token" element={<PublicSharePage />} />
        <Route
          path="/chat"
          element={
            <RequireAuth>
              <ChatPage />
            </RequireAuth>
          }
        />
        <Route
          path="/chat/:conversationId"
          element={
            <RequireAuth>
              <ChatPage />
            </RequireAuth>
          }
        />
        <Route
          path="/dashboards"
          element={
            <RequireAuth>
              <DashboardsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/dashboards/:dashboardId"
          element={
            <RequireAuth>
              <DashboardsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/scheduled"
          element={
            <RequireAuth>
              <ScheduledTasksPage />
            </RequireAuth>
          }
        />
        <Route
          path="/memory"
          element={
            <RequireAuth>
              <MemoryPage />
            </RequireAuth>
          }
        />
        <Route
          path="/reports/:id"
          element={
            <RequireAuth>
              <ReportPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/users"
          element={
            <RequireAdmin>
              <UsersPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/departments"
          element={
            <RequireAdmin>
              <DepartmentsPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/roles"
          element={
            <RequireAdmin>
              <RolesPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/skills"
          element={
            <RequireAdmin>
              <SkillsPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/mcp"
          element={
            <RequireAdmin>
              <McpPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/datasources"
          element={
            <RequireAdmin>
              <DatasourcesPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/datasources/:datasourceId/scope"
          element={
            <RequireAdmin>
              <DatasourceScopePage />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/datasources/:datasourceId/semantic"
          element={
            <RequireAdmin>
              <DatasourceSemanticPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/audit"
          element={
            <RequireAdmin>
              <AuditPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/settings"
          element={
            <RequireAdmin>
              <SettingsPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin/ops"
          element={
            <RequireAdmin>
              <OpsPage />
            </RequireAdmin>
          }
        />
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <BrandingProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </QueryClientProvider>
    </BrandingProvider>
  );
}
