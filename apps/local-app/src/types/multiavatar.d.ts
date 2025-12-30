declare module '@multiavatar/multiavatar' {
  export type MultiavatarVersion = {
    part: string;
    theme: string;
  };

  export default function multiavatar(
    seed: string,
    sansEnv?: boolean,
    version?: MultiavatarVersion,
  ): string;
}
