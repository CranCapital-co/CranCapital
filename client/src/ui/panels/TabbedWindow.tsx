import { Suspense, lazy, type ComponentType } from 'react';
import { useGame } from '../../lib/store';
import { Window, Tabs, EmbedContext, Loading } from '../components';

// A dock window made of tabs, each one an existing window shown without its
// own frame (Empire: overview, businesses, storage, bank; People: chat,
// leaders).
export function TabbedWindow({
  title,
  icon,
  tabs,
  params,
  extra,
}: {
  title: string;
  icon: string;
  tabs: [string, string, ComponentType<any>][];
  params?: { tab?: string; inner?: any };
  extra?: Record<string, unknown>;
}) {
  const open = useGame((s) => s.open);
  const tab = params?.tab && tabs.some((t) => t[0] === params.tab) ? params.tab : tabs[0][0];
  const Comp = tabs.find((t) => t[0] === tab)![2];
  return (
    <Window title={title} icon={icon} wide={tab === 'chat' || tab === 'leaders' ? false : undefined}>
      <div className="tab-sticky">
        <Tabs tabs={tabs.map(([k, label]) => [k, label] as [string, string])} value={tab} onChange={(k) => open(useGame.getState().win!.id, { tab: k })} />
      </div>
      <EmbedContext.Provider value={true}>
        <Suspense fallback={<Loading />}>
          <Comp key={tab} params={params?.inner ?? {}} {...extra} />
        </Suspense>
      </EmbedContext.Provider>
    </Window>
  );
}

export const lazyPanel = (f: () => Promise<{ default: ComponentType<any> }>) => lazy(f);
