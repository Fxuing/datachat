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
