import { TabbedWindow, lazyPanel } from './TabbedWindow';

const CommunityWindow = lazyPanel(() => import('./CommunityWindow'));
const LeaderboardWindow = lazyPanel(() => import('./LeaderboardWindow'));

export default function PeopleWindow({ params, api, city }: { params?: any; api: any; city: any }) {
  return (
    <TabbedWindow
      title="People"
      icon="people"
      params={params}
      extra={{ api, city }}
      tabs={[
        ['chat', 'Chat and friends', CommunityWindow],
        ['leaders', 'Leaderboards', LeaderboardWindow],
      ]}
    />
  );
}
