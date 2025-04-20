"use client";
import { useState } from "react";
import { api } from "@/utils/api";
import Swal from "sweetalert2";

interface PasswordManagerProps {
  userId: string;
}

export default function PasswordManager({ userId }: PasswordManagerProps) {
  const [passwords, setPasswords] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [newPassword, setNewPassword] = useState({
    passwordName: "",
    telegramPassword: "",
    facebookPassword: "",
  });

  const loadPasswords = async () => {
    try {
      setLoading(true);
      const data = await api.getUserPasswords(userId);
      setPasswords(data);
    } catch (error) {
      Swal.fire({
        icon: "error",
        title: "Error",
        text: "Failed to load passwords",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleAddPassword = async () => {
    try {
      setLoading(true);
      await api.addPassword(userId, newPassword);
      setNewPassword({
        passwordName: "",
        telegramPassword: "",
        facebookPassword: "",
      });
      await loadPasswords();
      Swal.fire({
        icon: "success",
        title: "Success",
        text: "Password added successfully",
      });
    } catch (error) {
      Swal.fire({
        icon: "error",
        title: "Error",
        text: "Failed to add password",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyPassword = async (passwordId: string, passwordType: "telegram" | "facebook", password: string) => {
    try {
      setLoading(true);
      const result = await api.verifyPassword(userId, passwordId, passwordType, password);
      Swal.fire({
        icon: result.isValid ? "success" : "error",
        title: result.isValid ? "Success" : "Error",
        text: result.isValid ? "Password is valid" : "Password is invalid",
      });
    } catch (error) {
      Swal.fire({
        icon: "error",
        title: "Error",
        text: "Failed to verify password",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="password-manager">
      <h2>Password Manager</h2>
      
      <div className="add-password">
        <h3>Add New Password</h3>
        <input
          type="text"
          placeholder="Password Name"
          value={newPassword.passwordName}
          onChange={(e) => setNewPassword({ ...newPassword, passwordName: e.target.value })}
        />
        <input
          type="password"
          placeholder="Telegram Password"
          value={newPassword.telegramPassword}
          onChange={(e) => setNewPassword({ ...newPassword, telegramPassword: e.target.value })}
        />
        <input
          type="password"
          placeholder="Facebook Password"
          value={newPassword.facebookPassword}
          onChange={(e) => setNewPassword({ ...newPassword, facebookPassword: e.target.value })}
        />
        <button onClick={handleAddPassword} disabled={loading}>
          {loading ? "Adding..." : "Add Password"}
        </button>
      </div>

      <div className="password-list">
        <h3>Your Passwords</h3>
        <button onClick={loadPasswords} disabled={loading}>
          {loading ? "Loading..." : "Refresh Passwords"}
        </button>
        
        {passwords.map((password) => (
          <div key={password._id} className="password-item">
            <h4>{password.passwordName}</h4>
            {password.telegramPassword && (
              <div>
                <input type="password" placeholder="Enter Telegram Password" />
                <button
                  onClick={() =>
                    handleVerifyPassword(
                      password._id,
                      "telegram",
                      (document.querySelector(`input[placeholder="Enter Telegram Password"]`) as HTMLInputElement).value
                    )
                  }
                >
                  Verify Telegram Password
                </button>
              </div>
            )}
            {password.facebookPassword && (
              <div>
                <input type="password" placeholder="Enter Facebook Password" />
                <button
                  onClick={() =>
                    handleVerifyPassword(
                      password._id,
                      "facebook",
                      (document.querySelector(`input[placeholder="Enter Facebook Password"]`) as HTMLInputElement).value
                    )
                  }
                >
                  Verify Facebook Password
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
} 