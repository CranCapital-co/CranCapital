// The site footer: links, the credit line and map credits.
export function Footer() {
  return (
    <footer className="footer">
      <nav>
        <a href="#/wiki">Help and wiki</a>
        <a href="#/legal/rules">Community rules</a>
        <a href="#/legal/terms">Terms of use</a>
        <a href="#/legal/privacy">Privacy policy</a>
        <a href="#/legal/credits">Credits</a>
        <a href="#/report">Report illegal content</a>
      </nav>
      <div>CranCapital is based on Capital Rift by NIKS GAMES LLC, used with their permission.</div>
      <div>
        Map data <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>. Map tiles by{' '}
        <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>.
      </div>
      <div>In-game money has no real-world value and can’t be bought or cashed out.</div>
    </footer>
  );
}
