const base = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 2,
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
  "aria-hidden": true,
};

export const ShareIcon = () => (
  <svg {...base}>
    <path d="M12 3v12" />
    <path d="m7 8 5-5 5 5" />
    <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
  </svg>
);

export const DownloadIcon = () => (
  <svg {...base}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
);

export const CloseIcon = () => (
  <svg {...base}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const VideoIcon = () => (
  <svg {...base} width={22} height={22}>
    <rect x="2" y="5" width="14" height="14" rx="2" />
    <path d="m16 10 6-3v10l-6-3" />
  </svg>
);

export const CheckIcon = () => (
  <svg {...base} width={16} height={16}>
    <path d="m5 12 5 5L20 7" />
  </svg>
);
