import { StatePanel } from "@/components/ui/state-panel";

export default function AppLoading() {
  return (
    <StatePanel
      kind="loading"
      title="Loading surface"
      description="The route is rendering. This static shell does not fetch session, message, call, or AI data."
      live
    />
  );
}
