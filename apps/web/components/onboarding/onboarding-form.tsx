"use client";

import { useEffect, useRef, useState } from "react";

import { isLocale } from "@chat/contracts";

import { ActionButton } from "@/components/ui/action-button";
import { ActionLink } from "@/components/ui/action-link";
import { GeneratedAvatar } from "@/components/ui/avatar";
import { useI18n } from "@/src/i18n/provider";

import styles from "./onboarding-form.module.css";

const steps = [
  { labelKey: "onboarding.form.steps.name", titleKey: "onboarding.form.stepTitles.name" },
  {
    labelKey: "onboarding.form.steps.username",
    titleKey: "onboarding.form.stepTitles.username",
  },
  { labelKey: "onboarding.form.steps.about", titleKey: "onboarding.form.stepTitles.about" },
] as const;

const usernamePattern = /^[a-z][a-z0-9_]{2,23}$/;

type OnboardingErrorKey = "onboarding.form.errorName" | "onboarding.form.errorUsername";

export function OnboardingForm() {
  const { locale, setLocale, t, timeZone } = useI18n();
  const [step, setStep] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [bio, setBio] = useState("");
  const [errorKey, setErrorKey] = useState<OnboardingErrorKey | null>(null);
  const [finished, setFinished] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(step);

  useEffect(() => {
    if (previousStep.current === step) {
      return;
    }

    previousStep.current = step;
    headingRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (finished) {
      headingRef.current?.focus();
    }
  }, [finished]);

  const trimmedName = displayName.trim();
  const usernameIsValid = usernamePattern.test(username);
  const languageName = locale === "bn" ? t("locale.bengali") : t("locale.english");

  function handleNext() {
    if (step === 0 && (trimmedName.length < 1 || trimmedName.length > 50)) {
      setErrorKey("onboarding.form.errorName");
      return;
    }

    if (step === 1 && !usernameIsValid) {
      setErrorKey("onboarding.form.errorUsername");
      return;
    }

    setErrorKey(null);
    setStep((current) => Math.min(current + 1, steps.length - 1));
  }

  if (finished) {
    return (
      <div className={styles.complete}>
        <GeneratedAvatar
          userId="onboarding-preview"
          name={trimmedName || t("common.sampleUser")}
          size="xl"
          ring
          decorative={false}
        />
        <p className={styles.completeEyebrow}>{t("onboarding.form.completeEyebrow")}</p>
        <h2 className={styles.completeTitle} ref={headingRef} tabIndex={-1}>
          {t("onboarding.form.completeTitle")}
        </h2>
        <p className={styles.completeBody}>{t("onboarding.form.completeBody")}</p>

        <dl className={styles.review}>
          <div>
            <dt>{t("onboarding.form.reviewDisplayName")}</dt>
            <dd>{trimmedName || t("onboarding.form.notEntered")}</dd>
          </div>
          <div>
            <dt>{t("onboarding.form.usernameLabel")}</dt>
            <dd>{username ? `@${username}` : t("onboarding.form.notEntered")}</dd>
          </div>
          <div>
            <dt>{t("onboarding.form.reviewBio")}</dt>
            <dd>{bio.trim() || t("onboarding.form.notEntered")}</dd>
          </div>
          <div>
            <dt>{t("onboarding.form.reviewLanguage")}</dt>
            <dd>
              <span lang={locale}>{languageName}</span> {t("onboarding.form.provisional")}
            </dd>
          </div>
          <div>
            <dt>{t("onboarding.form.reviewTimezone")}</dt>
            <dd>{timeZone}</dd>
          </div>
        </dl>

        <div className={styles.actions}>
          <ActionLink href="/profile">{t("onboarding.form.returnProfile")}</ActionLink>
          <ActionButton
            variant="ghost"
            onClick={() => {
              setFinished(false);
              setStep(0);
              setErrorKey(null);
            }}
          >
            {t("onboarding.form.startOver")}
          </ActionButton>
        </div>
      </div>
    );
  }

  return (
    <form
      className={styles.form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();

        if (step === steps.length - 1) {
          setFinished(true);
          return;
        }

        handleNext();
      }}
    >
      <nav className={styles.progress} aria-label={t("onboarding.form.progressAria")}>
        <p className={styles.stepCount}>
          {t("onboarding.form.stepOf", { current: step + 1, total: steps.length })}
        </p>
        <ol className={styles.stepList}>
          {steps.map((entry, index) => (
            <li
              className={styles.stepItem}
              key={entry.labelKey}
              aria-current={index === step ? "step" : undefined}
            >
              <span className={styles.stepNumber} aria-hidden="true">
                {index + 1}
              </span>
              <span className={styles.stepLabel}>{t(entry.labelKey)}</span>
            </li>
          ))}
        </ol>
      </nav>

      <div className={styles.stepBody}>
        <p className={styles.stepEyebrow}>{t("onboarding.form.stepEyebrow", { step: step + 1 })}</p>
        <h2 className={styles.stepTitle} ref={headingRef} tabIndex={-1}>
          {t(steps[step]?.titleKey ?? "onboarding.form.stepTitles.name")}
        </h2>

        {step === 0 ? (
          <>
            <p className={styles.stepDescription}>{t("onboarding.form.nameDescription")}</p>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="display-name">
                {t("onboarding.form.displayName")}
              </label>
              <input
                className={styles.input}
                id="display-name"
                name="display-name"
                type="text"
                autoComplete="name"
                maxLength={50}
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                  setErrorKey(null);
                }}
                aria-invalid={errorKey ? true : undefined}
                aria-describedby={
                  errorKey ? "display-name-hint onboarding-error" : "display-name-hint"
                }
                placeholder={t("onboarding.form.displayNamePlaceholder")}
              />
              <p className={styles.hint} id="display-name-hint">
                {t("onboarding.form.displayNameHint")}
              </p>
            </div>

            <div className={styles.avatarPreview}>
              <GeneratedAvatar
                userId="onboarding-preview"
                name={trimmedName || t("common.sampleUser")}
                size="xl"
                ring
                decorative={false}
              />
              <div>
                <p className={styles.previewTitle}>{t("onboarding.form.avatarTitle")}</p>
                <p className={styles.previewText}>{t("onboarding.form.avatarText")}</p>
              </div>
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <p className={styles.stepDescription}>{t("onboarding.form.usernameDescription")}</p>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="username">
                {t("onboarding.form.usernameLabel")}
              </label>
              <div className={styles.usernameField}>
                <span className={styles.prefix} aria-hidden="true">
                  @
                </span>
                <input
                  className={`${styles.input} ${styles.usernameInput}`}
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  minLength={3}
                  maxLength={24}
                  value={username}
                  onChange={(event) => {
                    setUsername(event.target.value.toLowerCase());
                    setErrorKey(null);
                  }}
                  aria-invalid={errorKey ? true : undefined}
                  aria-describedby={errorKey ? "username-hint onboarding-error" : "username-hint"}
                  placeholder={t("onboarding.form.usernamePlaceholder")}
                />
              </div>
              <p className={styles.hint} id="username-hint">
                {t("onboarding.form.usernameHint")}
              </p>
            </div>

            <div className={styles.example}>
              <p className={styles.exampleTitle}>{t("onboarding.form.formatTitle")}</p>
              <p>
                {t("onboarding.form.formatText", {
                  valid: t("onboarding.form.formatValid"),
                  invalid1: t("onboarding.form.formatInvalid1"),
                  invalid2: t("onboarding.form.formatInvalid2"),
                })}
              </p>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <p className={styles.stepDescription}>{t("onboarding.form.aboutDescription")}</p>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="bio">
                {t("onboarding.form.bioLabel")}{" "}
                <span className={styles.optional}>{t("onboarding.form.bioOptional")}</span>
              </label>
              <textarea
                className={styles.textarea}
                id="bio"
                name="bio"
                maxLength={160}
                rows={3}
                value={bio}
                onChange={(event) => setBio(event.target.value)}
                aria-describedby="bio-hint"
                placeholder={t("onboarding.form.bioPlaceholder")}
              />
              <div className={styles.fieldMeta}>
                <p className={styles.hint} id="bio-hint">
                  {t("onboarding.form.bioHint")}
                </p>
                <p className={styles.count} aria-hidden="true">
                  {t("onboarding.form.bioCount", { count: bio.length })}
                </p>
              </div>
            </div>

            <div className={styles.twoFields}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="language">
                  {t("onboarding.form.languageLabel")}
                </label>
                <select
                  className={styles.select}
                  id="language"
                  name="language"
                  value={locale}
                  onChange={(event) => {
                    if (isLocale(event.target.value)) {
                      setLocale(event.target.value);
                    }
                  }}
                  aria-describedby="language-hint"
                >
                  <option value="en">{t("locale.english")}</option>
                  <option value="bn" lang="bn">
                    {t("locale.bengali")}
                  </option>
                </select>
                <p className={styles.hint} id="language-hint">
                  {t("onboarding.form.languageHint")}
                </p>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="timezone">
                  {t("onboarding.form.timezoneLabel")}
                </label>
                <input
                  className={styles.select}
                  id="timezone"
                  name="timezone"
                  type="text"
                  value={timeZone}
                  readOnly
                  aria-describedby="timezone-hint"
                />
                <p className={styles.hint} id="timezone-hint">
                  {t("onboarding.form.timezoneHint")}
                </p>
              </div>
            </div>

            <div className={styles.reviewCard}>
              <div className={styles.reviewHeader}>
                <GeneratedAvatar
                  userId="onboarding-preview"
                  name={trimmedName || t("common.sampleUser")}
                  size="lg"
                  ring
                  decorative={false}
                />
                <div>
                  <p className={styles.previewTitle}>{trimmedName || t("common.sampleUser")}</p>
                  <p className={styles.previewText}>
                    {username ? `@${username}` : t("onboarding.form.notEntered")}
                  </p>
                </div>
              </div>
              <dl className={styles.review}>
                <div>
                  <dt>{t("onboarding.form.reviewBio")}</dt>
                  <dd>{bio.trim() || t("onboarding.form.notEntered")}</dd>
                </div>
                <div>
                  <dt>{t("onboarding.form.reviewLanguage")}</dt>
                  <dd>
                    <span lang={locale}>{languageName}</span> {t("onboarding.form.provisional")}
                  </dd>
                </div>
                <div>
                  <dt>{t("onboarding.form.reviewTimezone")}</dt>
                  <dd>{timeZone}</dd>
                </div>
              </dl>
            </div>
          </>
        ) : null}

        {errorKey ? (
          <p className={styles.error} id="onboarding-error" role="alert">
            {t(errorKey)}
          </p>
        ) : null}
      </div>

      <div className={styles.nav}>
        <ActionButton
          variant="ghost"
          onClick={() => {
            setErrorKey(null);
            setStep((current) => Math.max(current - 1, 0));
          }}
          disabled={step === 0}
        >
          {t("onboarding.form.back")}
        </ActionButton>
        <div className={styles.navPrimary}>
          <p className={styles.navNote}>
            {step === steps.length - 1
              ? t("onboarding.form.navNoteFinish")
              : t("onboarding.form.navNote")}
          </p>
          <ActionButton type="submit" variant="primary">
            {step === steps.length - 1
              ? t("onboarding.form.previewFinish")
              : t("onboarding.form.continue")}
          </ActionButton>
        </div>
      </div>
    </form>
  );
}
