export {};

declare global {
  interface Window {
    Telegram: {
      WebApp: {
        showAlert(arg0: string): unknown;
        initData: string;
        expand: () => void;
        initDataUnsafe?: {
          user?: {
            id?: number;
            username?: string;
            first_name?: string;
            last_name?: string;
          };
        };
      };
    };
  }
}
