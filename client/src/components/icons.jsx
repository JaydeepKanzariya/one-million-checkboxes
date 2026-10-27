// Stroke icons drawn on a 24px grid (paths follow Lucide, ISC licence).
function Icon({ children, size = 16, className = 'icon' }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

export const MinusIcon = ({ size = 16 }) => (
  <Icon size={size}>
    <path d="M5 12h14" />
  </Icon>
);

export const PlusIcon = ({ size = 16 }) => (
  <Icon size={size}>
    <path d="M5 12h14M12 5v14" />
  </Icon>
);

export const FitIcon = ({ size = 16 }) => (
  <Icon size={size}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
  </Icon>
);

export const TargetIcon = ({ size = 16 }) => (
  <Icon size={size}>
    <circle cx="12" cy="12" r="3" />
    <circle cx="12" cy="12" r="7" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </Icon>
);

export const ArrowRightIcon = ({ size = 14 }) => (
  <Icon size={size}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

export const KeyIcon = ({ size = 15 }) => (
  <Icon size={size}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m10.7 12.3 9.3-9.3M16 7l3 3M19 4l2 2" />
  </Icon>
);

export const LockIcon = ({ size = 16 }) => (
  <Icon size={size}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Icon>
);

export const ShuffleIcon = ({ size = 14 }) => (
  <Icon size={size}>
    <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
  </Icon>
);

export const ZapIcon = ({ size = 16 }) => (
  <Icon size={size}>
    <path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z" />
  </Icon>
);

export const DatabaseIcon = ({ size = 16 }) => (
  <Icon size={size}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
    <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
  </Icon>
);

export const ShieldIcon = ({ size = 16 }) => (
  <Icon size={size}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </Icon>
);

export const UsersIcon = ({ size = 16 }) => (
  <Icon size={size}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </Icon>
);

export const ShareIcon = ({ size = 16 }) => (
  <Icon size={size}>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
  </Icon>
);

export const MonitorIcon = ({ size = 16 }) => (
  <Icon size={size}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </Icon>
);

export const ServerIcon = ({ size = 16 }) => (
  <Icon size={size}>
    <rect x="2" y="3" width="20" height="7" rx="2" />
    <rect x="2" y="14" width="20" height="7" rx="2" />
    <path d="M6 6.5h.01M6 17.5h.01" />
  </Icon>
);

export const ActivityIcon = ({ size = 16 }) => (
  <Icon size={size}>
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </Icon>
);

// 28px square with a 1.5px --ink border and a "+–" glyph inside (U4)
export const BrandMark = () => (
  <span className="brand-box" aria-hidden="true">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M4 4.5v5M1.5 7h5M8.5 7h4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  </span>
);
