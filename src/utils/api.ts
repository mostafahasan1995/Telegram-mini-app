const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface TelegramUserData {
  telegramId: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
  authDate: Date;
  hash: string;
}

interface PasswordData {
  passwordName: string;
  telegramPassword?: string;
  facebookPassword?: string;
}

export const api = {
  async signup(userData: TelegramUserData) {
    const response = await fetch(`${API_BASE_URL}/users/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(userData),
    });

    if (!response.ok) {
      throw new Error('Signup failed');
    }

    return response.json();
  },

  async addPassword(userId: string, passwordData: PasswordData) {
    const response = await fetch(`${API_BASE_URL}/users/${userId}/passwords`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(passwordData),
    });

    if (!response.ok) {
      throw new Error('Failed to add password');
    }

    return response.json();
  },

  async getUserPasswords(userId: string) {
    const response = await fetch(`${API_BASE_URL}/users/${userId}/passwords`);

    if (!response.ok) {
      throw new Error('Failed to fetch passwords');
    }

    return response.json();
  },

  async verifyPassword(userId: string, passwordId: string, passwordType: 'telegram' | 'facebook', password: string) {
    const response = await fetch(`${API_BASE_URL}/users/${userId}/passwords/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        passwordId,
        passwordType,
        password,
      }),
    });

    if (!response.ok) {
      throw new Error('Password verification failed');
    }

    return response.json();
  },
}; 