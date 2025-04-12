import { useState } from "react";
import Swal from "sweetalert2";
import defaultImage from "@/assets/images/no-User.png";

export default function useTelegramSearch(){
  const [inputSearch, setInputSearch] = useState<string>("");
  const [profileImage, setProfileImage] = useState<string | null>(null);
  
  const search = () => getTelegramProfilePicture(inputSearch);

  function isImageLoadable(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const img = new Image();
      img.src = url;
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
    });
  }
    
  async function getTelegramProfilePicture(text: string) {
    setProfileImage(null);
    // if user start username with @, deleted
    const username = text.startsWith("@") ? text.substring(1) : text;
    // call end point to get response from https://t.me/username
    const response = await fetch(`/api/get-telegram-profile?username=${username}`);

    if(!response.ok){
        const error = await response.json();
        Swal.fire({
            icon: "error",
            title: "Error",
            text: error?.error
        })
        return;
    }

    // convert response to text
    const html = await response.text();
    // Check if the response contains this class, the user does not exist
    const notFoundClassExists = html.includes("tl_main_download_link tl_main_download_link_ios");
    const ffff = html.includes("tgme_icon_user");
    if (notFoundClassExists || ffff) {
        Swal.fire({
            icon: "warning",
            title: "User Not Found",
            text: `No Telegram user found for @${username}`,
          });
        return;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const img: any = doc.querySelector(".tgme_page_photo_image");

    if (img) {
        const isLoadable = await isImageLoadable(img.src);
        setProfileImage(isLoadable ? img.src : defaultImage.src);
    } else {
        setProfileImage(defaultImage.src);
    }
  }

    return {search, setInputSearch, profileImage};
};