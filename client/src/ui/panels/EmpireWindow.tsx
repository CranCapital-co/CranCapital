import { TabbedWindow, lazyPanel } from './TabbedWindow';
import Dashboard from './Dashboard';

const BusinessesWindow = lazyPanel(() => import('./BusinessesWindow'));
const InventoryWindow = lazyPanel(() => import('./InventoryWindow'));
const BankWindow = lazyPanel(() => import('./BankWindow'));
const CityJobs = lazyPanel(() => import('./CityJobs'));

export default function EmpireWindow({ params, api, city }: { params?: any; api: any; city: any }) {
  return (
    <TabbedWindow
      title="Your empire"
      icon="empire"
      params={params}
      extra={{ api, city }}
      tabs={[
        ['overview', 'Overview', Dashboard],
        ['businesses', 'Businesses', BusinessesWindow],
        ['storage', 'Storage', InventoryWindow],
        ['bank', 'Bank', BankWindow],
        ['city', 'City jobs', CityJobs],
      ]}
    />
  );
}
