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

const ChatPage = lazy(() => import("./pages/ChatPage"));
const ReportPage = lazy(() => import("./pages/ReportPage"));
const SkillsPage = lazy(() => import("./pages/admin/SkillsPage"));
const McpPage = lazy(() => import("./pages/admin/McpPage"));
const DatasourcesPage = lazy(() => import("./pages/admin/DatasourcesPage"));

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
          path="/reports/:id"
          element={
            <RequireAuth>
              <ReportPage />
            </RequireAuth>
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
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
