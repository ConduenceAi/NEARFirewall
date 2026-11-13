import { href } from "../router.ts";

export function Brand() {
  return (
    <a className="brand" href={href("/")} aria-label="NEARFirewall home">
      <img className="logo" src="/logo-green.png" width={36} height={36} alt="" />
      <strong className="brand-text">NEARFirewall</strong>
    </a>
  );
}
