import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & {
  size?: number;
};

function Icon({ size = 22, children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {children}
    </svg>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20.5 11.6a8.1 8.1 0 0 1-8.3 8.1 9 9 0 0 1-3.5-.7L4 20.5l1.4-4.2a7.8 7.8 0 0 1-1.2-4.2 8.1 8.1 0 0 1 8.3-8.1 8.1 8.1 0 0 1 8 7.6Z" />
      <path d="M8.7 11.8h.01M12.3 11.8h.01M15.9 11.8h.01" />
    </Icon>
  );
}

export function PhoneIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.3 3.8h2.4l1.2 3.3-1.7 1.2a12.8 12.8 0 0 0 6.8 6.8l1.2-1.7 3.3 1.2v2.4a2.5 2.5 0 0 1-2.7 2.5A16.4 16.4 0 0 1 3.8 6.5a2.5 2.5 0 0 1 2.5-2.7Z" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.5 15.5 4 4" />
    </Icon>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8.2" r="3.6" />
      <path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h6.5M14.5 7H20M4 17h3.5M11.5 17H20M4 12h10M18 12h2" />
      <circle cx="12.5" cy="7" r="2" />
      <circle cx="9.5" cy="17" r="2" />
      <circle cx="16" cy="12" r="2" />
    </Icon>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </Icon>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20.2 14.2A8.4 8.4 0 0 1 9.8 3.8a8.4 8.4 0 1 0 10.4 10.4Z" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m14.5 5.5-6.5 6.5 6.5 6.5" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 12h15M13.5 6l6 6-6 6" />
    </Icon>
  );
}

export function SparklesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5 13.6 8l4.4 1.6-4.4 1.6L12 15.6l-1.6-4.4L6 9.6 10.4 8 12 3.5Z" />
      <path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
      <path d="m5.5 15 .6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6Z" />
    </Icon>
  );
}

export function HeartIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 20.2S3.8 15.5 3.8 9.4A4.6 4.6 0 0 1 12 6.4a4.6 4.6 0 0 1 8.2 3c0 6.1-8.2 10.8-8.2 10.8Z" />
    </Icon>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect height="10.5" rx="3.2" width="6.4" x="8.8" y="3" />
      <path d="M5.8 11.2a6.2 6.2 0 0 0 12.4 0M12 17.4V21M9.2 21h5.6" />
    </Icon>
  );
}

export function CameraIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect height="12" rx="2.4" width="14" x="2.8" y="6.4" />
      <path d="m16.8 10.4 4.4-2.4v8l-4.4-2.4" />
    </Icon>
  );
}

export function PhoneOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.3 3.8h2.4l1.2 3.3-1.7 1.2a12.8 12.8 0 0 0 6.8 6.8l1.2-1.7 3.3 1.2v2.4a2.5 2.5 0 0 1-2.7 2.5A16.4 16.4 0 0 1 3.8 6.5a2.5 2.5 0 0 1 2.5-2.7Z" />
      <path d="m4 4 16 16" />
    </Icon>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20.5 3.5 3.8 10.1l6.4 2.5 2.5 6.4 7.8-15.5Z" />
      <path d="m10.2 12.6 4.4-4.4" />
    </Icon>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.2 5.2 6v5.3c0 4.4 2.8 7.7 6.8 9.5 4-1.8 6.8-5.1 6.8-9.5V6L12 3.2Z" />
      <path d="M9.4 12.2 11 13.8l3.8-4" />
    </Icon>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.8 12h16.4M12 3.5c2.2 2.3 3.3 5.2 3.3 8.5s-1.1 6.2-3.3 8.5c-2.2-2.3-3.3-5.2-3.3-8.5S9.8 5.8 12 3.5Z" />
    </Icon>
  );
}

export function MonitorIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect height="12" rx="2" width="17" x="3.5" y="4" />
      <path d="M9 20h6M12 16v4" />
    </Icon>
  );
}

export function DatabaseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <ellipse cx="12" cy="5.6" rx="7.2" ry="3" />
      <path d="M4.8 5.6v12.8c0 1.7 3.2 3 7.2 3s7.2-1.3 7.2-3V5.6M4.8 12c0 1.7 3.2 3 7.2 3s7.2-1.3 7.2-3" />
    </Icon>
  );
}
