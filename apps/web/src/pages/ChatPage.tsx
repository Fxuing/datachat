import { useQuery } from "@tanstack/react-query";
import { AppShell } from "../components/AppShell";
import { PageSpinner } from "../components/ui/spinner";
import { fetchMe } from "../lib/api";
import { queryKeys } from "../lib/query";

export default function ChatPage() {
  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const user = meQuery.data?.user;

  if (!user) {
    return <PageSpinner />;
  }

  return (
    <AppShell user={user} sidebar={<div className="p-4 text-xs text-neutral-500">会话列表即将上线</div>}>
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        聊天页正在开发中
      </div>
    </AppShell>
  );
}
