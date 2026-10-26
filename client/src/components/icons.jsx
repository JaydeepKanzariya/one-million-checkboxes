// Stroke icons drawn on a 24px grid (paths follow Lucide, ISC licence).
function Icon({ children, size = 16 }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

export const MinusIcon = () => (
  <Icon>
    <path d="M5 12h14" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M5 12h14M12 5v14" />
  </Icon>
);

export const FitIcon = () => (
  <Icon>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
  </Icon>
);

export const TargetIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <circle cx="12" cy="12" r="7" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-4-4" />
  </Icon>
);

export const MenuIcon = () => (
  <Icon>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);

export const BrandMark = () => (
  <svg className="brand-mark" width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
    <rect x="1.5" y="1.5" width="19" height="19" rx="4" />
    <path d="M6 11.3l3.4 3.4L16 7.4" />
  </svg>
);
