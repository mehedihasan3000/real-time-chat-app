import Image from "next/image";
import type { ReactNode } from "react";

import styles from "./photo-frame.module.css";

export function PhotoFrame({
  src,
  alt,
  className,
  sizes = "(min-width: 64rem) 42vw, 100vw",
  priority = false,
  position = "center",
  children,
}: {
  src: string;
  alt: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
  position?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`${styles.frame} ${className ?? ""}`}>
      <Image
        className={styles.image}
        src={src}
        alt={alt}
        fill
        sizes={sizes}
        priority={priority}
        style={{ objectPosition: position }}
      />
      {children}
    </div>
  );
}

export function PhotoStrip({ className }: { className?: string }) {
  return (
    <div className={`u-photo-strip ${styles.strip} ${className ?? ""}`}>
      <Image
        src="/images/paper-hearts.jpg"
        alt=""
        fill
        sizes="(min-width: 80rem) 76rem, 100vw"
        className={styles.stripImage}
      />
    </div>
  );
}
